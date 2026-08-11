/**
 * ── SESSION PERSISTENCE — THE TESTS THAT ARE ABOUT DECISIONS ────────────────
 *
 * Four of these pin things that would be silent in production:
 *
 *   · THE LEAK. A message history contains file contents, and `turn.mjs`
 *     documents the worst bug this package has had — the pre-load putting a
 *     real key into the prompt. Writing that transcript to disk is the same
 *     leak with a longer life, so the `.env` read, the `.env` WRITE (the secret
 *     is in the call arguments, not the reply) and the bare key are each driven
 *     separately and the file on disk is grepped afterwards.
 *   · THE REPLAY. A trailing `tool_calls` with no answer is a PENDING action,
 *     not a memory of one. This is asserted on a `run_command` specifically,
 *     because that is the case where being wrong re-runs a command.
 *   · THE PAIRING. Truncation is where this breaks: cut one message and the
 *     conversation earns an HTTP 400. Every kept `tool` message is checked
 *     against a declaring `tool_calls` after a forced truncation.
 *   · THE DRIFT GUARD. `SECRET_NAME` is a deliberate copy of `command.mjs`'s
 *     pattern (that file exports it to nobody and this module may not edit it).
 *     So the real `scrubEnvironment` is driven with a probe environment and the
 *     two definitions are compared name by name. They cannot diverge quietly.
 *
 * ⚠️ ON "CHILD-PROCESS SHUTDOWN": this module spawns nothing, and the honest
 * test for that is a STATIC one — a behavioural test would pass trivially today
 * and keep passing on the day someone adds a spawn. `spawns nothing, statically`
 * reads the source. The behavioural half is covered by the replay tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scrubEnvironment } from '../lib/command.mjs';
import {
  saveSession, loadSession, resumeMessages, listSessions, pruneSessions,
  sanitizeMessages, redactSecrets, isCredentialPath, newSessionId,
  resolveSessionFile, summarizeSession, sessionToolSchemas, REGISTRATION_SNIPPET,
  SESSION_DIR, MAX_SESSIONS,
} from '../lib/session.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvosession-'));

/** A minimal but REAL SessionOutcome, shaped exactly as turn.mjs returns one. */
function outcome({ messages = [], executed = [], stoppedBecause = 'round-cap', roundsUsed = 2 } = {}) {
  return {
    ok: true,
    stage: 'done',
    model: 'deepseek/deepseek-chat',
    note: 'done',
    finishReason: 'stop',
    usage: { cost: 0.0006, total_tokens: 4200 },
    executed,
    rounds: [],
    roundsUsed,
    maxRounds: 4,
    allowRun: true,
    stoppedBecause,
    verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, timedOut: false, attempts: 1 },
    promisedButMissing: [],
    messages,
  };
}

const assistantCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const toolReply = (id, name, content) => ({ role: 'tool', tool_call_id: id, name, content });

const conversation = (...rest) => [
  { role: 'system', content: 'You are Acuvo Code.' },
  { role: 'user', content: 'Task: port utils.mjs to promises.\n\nWorkspace:\nutils.mjs (400 bytes)' },
  ...rest,
];

// ───────────────────────────────────────────────────────────────────────────
// The round trip
// ───────────────────────────────────────────────────────────────────────────

test('save → list → load → resume round-trips through the file', () => {
  const root = ws();
  const messages = conversation(
    assistantCall('c1', 'write_file', { path: 'utils.mjs', content: 'export const x = 1;' }),
    toolReply('c1', 'write_file', 'wrote utils.mjs (19 bytes)'),
    assistantCall('c2', 'run_command', { command: 'npm test' }),
    toolReply('c2', 'run_command', 'exit 0 — 3 passing'),
  );
  const executed = [
    { id: 'c1', name: 'write_file', args: { path: 'utils.mjs' }, result: { ok: true, path: 'utils.mjs', bytes: 19, created: true }, mutated: true },
    { id: 'c2', name: 'run_command', args: { command: 'npm test' }, result: { ok: true, passed: true, exitCode: 0, command: 'npm test', stdout: '3 passing' }, mutated: false },
  ];

  const saved = saveSession(root, outcome({ messages, executed }), { task: 'port utils.mjs to promises' });
  assert.equal(saved.ok, true);
  assert.equal(saved.resumable, true);

  // It is on DISK, not in this process's memory — that is the entire premise.
  const onDisk = readdirSync(join(root, '.acuvo', 'sessions'));
  assert.deepEqual(onDisk, [`${saved.id}.json`]);

  const listed = listSessions(root);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].files, 1);
  assert.equal(listed.sessions[0].commands, 1);
  assert.match(listed.sessions[0].summary, /1 file · 1 cmd · round-cap — port utils\.mjs to promises$/);

  const resumed = resumeMessages(root, saved.id);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.replayed, false);
  // System + user + two full call/reply pairs + the resume note.
  assert.equal(resumed.messages.length, 7);
  assert.equal(resumed.messages[0].role, 'system');
  assert.equal(resumed.messages.at(-1).role, 'user');
  assert.match(resumed.messages.at(-1).content, /ALREADY HAPPENED/);
  assert.match(resumed.messages.at(-1).content, /Nothing has been re-run/);
  // The learning survives: the model does not have to re-read utils.mjs.
  assert.equal(resumed.messages[3].content, 'wrote utils.mjs (19 bytes)');
});

test('the recorded facts come from executed, not from the prose', () => {
  const root = ws();
  const executed = [
    { name: 'write_file', args: { path: 'a.mjs' }, result: { ok: true, path: 'a.mjs', bytes: 10, created: true } },
    { name: 'edit_file', args: { path: 'b.mjs' }, result: { ok: true, path: 'b.mjs', bytes: 12, created: false } },
    { name: 'delete_file', args: { path: 'c.mjs' }, result: { ok: true, path: 'c.mjs', bytes: 3 } },
    { name: 'read_file', args: { path: 'd.mjs' }, result: { ok: true, path: 'd.mjs', content: 'x' } },
    { name: 'run_command', args: { command: 'npm test' }, result: { ok: true, passed: false, exitCode: 1, command: 'npm test', stderr: 'AssertionError: 1 !== 2' } },
  ];
  const saved = saveSession(root, outcome({ messages: conversation(), executed }), { task: 't' });
  const s = loadSession(root, saved.id).session;

  assert.deepEqual(s.files.map((f) => [f.path, f.action]), [['a.mjs', 'created'], ['b.mjs', 'changed'], ['c.mjs', 'deleted']]);
  // read_file is not an action on the tree and must not appear as one.
  assert.equal(s.files.find((f) => f.path === 'd.mjs'), undefined);
  assert.equal(s.commands[0].passed, false);
  assert.equal(s.commands[0].exitCode, 1);
  // The failure output is the most useful thing in the record.
  assert.match(s.commands[0].output, /AssertionError/);
});

// ───────────────────────────────────────────────────────────────────────────
// ⚠️ THE LEAK
// ───────────────────────────────────────────────────────────────────────────

const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';

test('a .env READ is withheld — the secret is in the reply, not the call', () => {
  const root = ws();
  const messages = conversation(
    assistantCall('c1', 'read_file', { path: '.env' }),
    toolReply('c1', 'read_file', `OPENROUTER_API_KEY=${FAKE_KEY}\nDB_PASSWORD=hunter2hunter2\n`),
  );
  const saved = saveSession(root, outcome({ messages }), { task: 'check config' });
  assert.equal(saved.ok, true);

  const raw = readFileSync(join(root, SESSION_DIR, `${saved.id}.json`), 'utf8');
  assert.equal(raw.includes(FAKE_KEY), false, 'the key must not be on disk');
  assert.equal(raw.includes('hunter2hunter2'), false, 'the password must not be on disk');
  assert.match(raw, /withheld/);
  assert.ok(saved.redactions > 0);
});

test('a .env WRITE is withheld too — that secret lives in the call arguments', () => {
  const root = ws();
  const messages = conversation(
    assistantCall('c1', 'write_file', { path: 'config/.env.local', content: `STRIPE_SECRET_KEY=${FAKE_KEY}` }),
    toolReply('c1', 'write_file', 'wrote config/.env.local (74 bytes)'),
  );
  const saved = saveSession(root, outcome({ messages }), { task: 'write env' });
  const raw = readFileSync(join(root, SESSION_DIR, `${saved.id}.json`), 'utf8');
  assert.equal(raw.includes(FAKE_KEY), false);
  // The arguments are stored as the JSON STRING the provider sent, so the
  // marker is escaped one level deep inside the record.
  assert.match(raw, /\\"withheld\\":true/);
});

test('a key that appears in ORDINARY output is redacted by shape', () => {
  const root = ws();
  const messages = conversation(
    assistantCall('c1', 'run_command', { command: 'node print.mjs' }),
    toolReply('c1', 'run_command', `exit 0\nusing ${FAKE_KEY} and ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAIOSFODNN7EXAMPLE`),
  );
  const saved = saveSession(root, outcome({ messages }), { task: 'run it' });
  const raw = readFileSync(join(root, SESSION_DIR, `${saved.id}.json`), 'utf8');
  assert.equal(raw.includes(FAKE_KEY), false);
  assert.equal(raw.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), false);
  assert.equal(raw.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.match(raw, /redacted openrouter key/);
});

test('the TASK line is redacted too — people paste keys into prompts', () => {
  const root = ws();
  const saved = saveSession(root, outcome({ messages: conversation() }), { task: `deploy with ${FAKE_KEY}` });
  const raw = readFileSync(join(root, SESSION_DIR, `${saved.id}.json`), 'utf8');
  assert.equal(raw.includes(FAKE_KEY), false);
});

test('a private key block is redacted whole, not line by line', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA3tZ\nkQIDAQAB\n-----END RSA PRIVATE KEY-----';
  const r = redactSecrets(`here it is:\n${pem}\ndone`);
  assert.equal(r.text.includes('MIIEowIBAAKCAQEA3tZ'), false);
  assert.match(r.text, /\[redacted private key\]/);
  assert.match(r.text, /^here it is:/);
});

/**
 * ⚠️ THE FALSE-POSITIVE DIRECTION, which is the one that ruins a resume. A
 * transcript full of redacted CODE is worse than no transcript: the model
 * reasons confidently about text that is not what the file says.
 */
test('ordinary code that merely MENTIONS a key is left alone', () => {
  const code = [
    'const apiKey = process.env.OPENROUTER_API_KEY;',
    'let tokenCount = tokens.length;',
    'const sessionStore = createStore();',
    'export const AUTH_HEADER = buildHeader(apiKey);',
    'password: getPassword(user),',
  ].join('\n');
  const r = redactSecrets(code);
  assert.equal(r.text, code, 'no code line should have been touched');
  assert.equal(r.redactions, 0);
});

test('but a literal assignment goes — quoted, env-style or opaque', () => {
  // env-style: no declaration keyword, `=`, no spaces. A dotenv line.
  assert.match(redactSecrets('DB_PASSWORD=correcthorsebattery').text, /DB_PASSWORD=\[redacted\]/);
  // quoted: a hardcoded literal, whatever the file format.
  assert.match(redactSecrets('  "apiKey": "abcd1234efgh5678"').text, /"apiKey": \[redacted\]/);
  assert.match(redactSecrets('const apiKey = "abcd1234efgh5678";').text, /const apiKey = \[redacted\]/);
  // a shell export is env-style too, despite the leading keyword.
  assert.match(redactSecrets('export GITHUB_TOKEN=aaaabbbbccccdddd').text, /GITHUB_TOKEN=\[redacted\]/);
  // opaque: unquoted YAML, letters and digits, no dotted access.
  assert.match(redactSecrets('password: hunter2secret').text, /password: \[redacted\]/);
  // Too short to be a credential, and refusing it would eat `let secretLen = 0`.
  assert.equal(redactSecrets('SECRET=abc').text, 'SECRET=abc');
});

test('the credential-path list is git.mjs\'s, not a second copy', () => {
  for (const p of ['.env', '.env.local', 'app/.env.production', 'id_rsa', 'certs/server.pem', 'secrets.json', '.npmrc', '.aws/credentials']) {
    assert.equal(isCredentialPath(p), true, `${p} must count as a credential file`);
  }
  for (const p of ['src/env.mjs', 'README.md', 'environment.ts']) {
    assert.equal(isCredentialPath(p), false, `${p} must NOT be treated as one`);
  }
});

/**
 * ⭐ THE DRIFT GUARD. `SECRET_NAME` here is a copy of `command.mjs`'s, because
 * that module exports it to nobody and this one may not edit it. Rather than
 * trusting the copy, drive the REAL scrubber and compare verdicts name by name.
 */
test('the secret-name pattern agrees with scrubEnvironment, name for name', () => {
  const names = [
    'OPENROUTER_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'PASSWD',
    'STRIPE_CREDENTIAL', 'PRIVATE_NOTE', 'SESSION_ID', 'COOKIE_DOMAIN', 'AUTH_URL',
    'SENTRY_DSN', 'DATABASE_CONNECTION_STRING', 'apiKey', 'my_token',
    'PATH', 'HOME', 'NODE_ENV', 'PORT', 'CI', 'MY_DB_STRING', 'LANG', 'TMPDIR', 'npm_config_cache',
  ];
  const probe = Object.fromEntries(names.map((n) => [n, 'x']));
  const survived = new Set(Object.keys(scrubEnvironment(probe)));

  for (const name of names) {
    const scrubberCallsItSecret = !survived.has(name);
    // `x` is too short for the value test, so drive the pattern with a literal.
    const oursCallsItSecret = redactSecrets(`${name}=aaaabbbbccccdddd`).redactions > 0;
    assert.equal(
      oursCallsItSecret, scrubberCallsItSecret,
      `session.mjs and command.mjs disagree about "${name}" — one of the two patterns has drifted`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// ⚠️ THE REPLAY GUARD
// ───────────────────────────────────────────────────────────────────────────

test('a trailing UNANSWERED run_command is dropped, not handed back as pending', () => {
  const root = ws();
  const messages = conversation(
    assistantCall('c1', 'write_file', { path: 'a.mjs', content: 'x' }),
    toolReply('c1', 'write_file', 'wrote a.mjs'),
    // The loop died here — turn.mjs pushes the assistant message BEFORE it runs
    // the tools, so a model-error or a Ctrl-C leaves exactly this.
    assistantCall('c2', 'run_command', { command: 'npm run deploy' }),
  );
  const saved = saveSession(root, outcome({ messages, stoppedBecause: 'model-error' }), { task: 'ship it' });
  assert.equal(saved.droppedIncomplete, 1);

  const resumed = resumeMessages(root, saved.id);
  const pending = resumed.messages.filter((m) => Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.function.name === 'run_command'));
  assert.equal(pending.length, 0, 'a resumed history must contain no unanswered command call');
  assert.equal(JSON.stringify(resumed.messages).includes('npm run deploy'), false);
  assert.match(resumed.messages.at(-1).content, /last round was incomplete/);
});

test('every kept tool message still has a declaring tool_call — even after truncation', () => {
  const big = 'y'.repeat(4_000);
  const rounds = [];
  for (let i = 0; i < 40; i += 1) {
    rounds.push(assistantCall(`c${i}`, 'read_file', { path: `src/file${i}.mjs` }));
    rounds.push(toolReply(`c${i}`, 'read_file', `${big}${i}`));
  }
  const clean = sanitizeMessages(conversation(...rounds), { maxBytes: 40_000 });
  assert.ok(clean.droppedGroups > 0, 'the cap must actually have bitten');

  const declared = new Set();
  for (const m of clean.messages) {
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) declared.add(c.id);
    if (m.role === 'tool') {
      assert.ok(declared.has(m.tool_call_id), `orphan tool message ${m.tool_call_id} — this conversation would be rejected with a 400`);
    }
  }
  // The head survives whatever happens, and so does the newest round.
  assert.equal(clean.messages[0].role, 'system');
  assert.match(JSON.stringify(clean.messages.at(-1)), /39/);
  // And the hole is announced rather than left silent.
  assert.match(clean.messages[2].content, /dropped to fit the saved-session size limit/);
});

test('one enormous message is truncated, and says so', () => {
  const clean = sanitizeMessages(conversation(
    assistantCall('c1', 'read_file', { path: 'huge.mjs' }),
    toolReply('c1', 'read_file', 'z'.repeat(50_000)),
  ));
  const reply = clean.messages.at(-1);
  assert.ok(reply.content.length < 12_000);
  assert.match(reply.content, /truncated 42000 characters/);
});

/**
 * ⚠️ THE HONEST VERSION OF "CHILD-PROCESS SHUTDOWN". A behavioural assertion
 * would pass today for free and keep passing on the day a spawn is added; the
 * property worth guarding is that this module has no way to start a process at
 * all, so it is read off the source.
 */
test('spawns nothing, statically', () => {
  const src = readFileSync(new URL('../lib/session.mjs', import.meta.url), 'utf8');
  // ⚠️ COMMENTS STRIPPED FIRST. The header DISCUSSES child_process at length —
  // that is the point of it — and a scan that cannot tell prose from code would
  // be red for the documentation and green for the day someone removes it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const forbidden of ['child_process', 'worker_threads', 'spawn(', 'execFile(', 'execSync(', 'fork(']) {
    assert.equal(code.includes(forbidden), false, `session.mjs must never reach for ${forbidden} — a resume reconstructs context, it never re-runs anything`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Refusals and corruption
// ───────────────────────────────────────────────────────────────────────────

test('the session directory is proven, not assumed', () => {
  const root = ws();
  for (const bad of ['../../outside.json', '/etc/passwd', 'C:/Windows/win.ini', 'a/../../../x.json']) {
    const r = resolveSessionFile(root, bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
  }
  const good = resolveSessionFile(root, '20260810-230511-ab12.json');
  assert.equal(good.ok, true);
  assert.equal(good.relative, `${SESSION_DIR}/20260810-230511-ab12.json`);
});

test('a disk-less workspace is refused with an instruction, not a crash', () => {
  const r = saveSession('(memory)', outcome({ messages: conversation() }), { task: 't' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no disk/);
  assert.equal(listSessions('(memory)').ok, false);
});

test('a missing session names the way to find the real ids', () => {
  const root = ws();
  const r = loadSession(root, '20260101-000000-zzzz');
  assert.equal(r.ok, false);
  assert.match(r.error, /--sessions/);
  // ⚠️ An error string is an instruction: it must not invite a blind retry.
  assert.equal(/try again/i.test(r.error), false);
});

test('a corrupt file cannot break the listing or the load', () => {
  const root = ws();
  mkdirSync(join(root, SESSION_DIR), { recursive: true });
  writeFileSync(join(root, SESSION_DIR, '20260810-120000-aaaa.json'), '{ not json', 'utf8');
  writeFileSync(join(root, SESSION_DIR, '20260810-130000-bbbb.json'), JSON.stringify({ version: 99, id: '20260810-130000-bbbb' }), 'utf8');
  saveSession(root, outcome({ messages: conversation() }), { task: 'a good one' });

  const listed = listSessions(root);
  assert.equal(listed.ok, true);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.unreadable, 2);

  const load = loadSession(root, '20260810-130000-bbbb');
  assert.equal(load.ok, false);
  assert.match(load.error, /corrupt or was written by a newer build/);
});

test('a run that died before round 1 is saved, listable, and NOT resumable', () => {
  const root = ws();
  const saved = saveSession(root, { ok: false, stage: 'model', error: 'HTTP 429 rate limited' }, { task: 'anything' });
  assert.equal(saved.ok, true);
  assert.equal(saved.resumable, false);

  const s = loadSession(root, saved.id).session;
  assert.equal(s.stoppedBecause, 'failed:model');
  assert.match(s.error, /429/);

  const r = resumeMessages(root, saved.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to resume/);
  assert.match(r.error, /Start a fresh run/);
});

test('resuming in a different workspace warns instead of lying', () => {
  const a = ws();
  const b = ws();
  const saved = saveSession(a, outcome({ messages: conversation(assistantCall('c1', 'read_file', { path: 'x.mjs' }), toolReply('c1', 'read_file', 'contents')) }), { task: 't' });
  // Move the record, keeping the recorded root pointing at the old tree.
  mkdirSync(join(b, SESSION_DIR), { recursive: true });
  writeFileSync(join(b, SESSION_DIR, `${saved.id}.json`), readFileSync(join(a, SESSION_DIR, `${saved.id}.json`), 'utf8'), 'utf8');

  const r = resumeMessages(b, saved.id);
  assert.equal(r.ok, true);
  assert.equal(r.rootChanged, true);
  assert.match(r.note, /DIFFERENT workspace/);
});

// ───────────────────────────────────────────────────────────────────────────
// Growth
// ───────────────────────────────────────────────────────────────────────────

test('the directory is capped by deleting the OLDEST, never by refusing the newest', () => {
  const root = ws();
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const id = `2026081${i}-120000-aa0${i}`;
    ids.push(id);
    const saved = saveSession(root, outcome({ messages: conversation() }), { task: `run ${i}`, id, keep: 3 });
    assert.equal(saved.ok, true, 'a save must never be refused because the directory is full');
  }
  const left = readdirSync(join(root, SESSION_DIR)).sort();
  assert.deepEqual(left, ids.slice(-3).map((i) => `${i}.json`));
});

test('ids sort chronologically as plain strings, and carry no colon', () => {
  const early = newSessionId(new Date('2026-08-09T23:05:11.402Z'));
  const later = newSessionId(new Date('2026-08-10T01:00:00.000Z'));
  assert.ok(early < later, 'lexical order must be chronological or prune deletes the wrong file');
  // ⚠️ `:` is a character workspace.mjs refuses outright — an ISO timestamp id
  // would fail to save on Windows and nowhere else.
  assert.equal(/[:.]/.test(early), false);
  assert.match(early, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});

test('a stale .tmp is swept; a fresh one is left for the process writing it', () => {
  const root = ws();
  mkdirSync(join(root, SESSION_DIR), { recursive: true });
  const stale = join(root, SESSION_DIR, '20260810-120000-aaaa.json.999-0.tmp');
  const fresh = join(root, SESSION_DIR, '20260810-130000-bbbb.json.999-1.tmp');
  writeFileSync(stale, 'x', 'utf8');
  writeFileSync(fresh, 'x', 'utf8');
  const old = new Date(Date.now() - 7_200_000);
  utimesSync(stale, old, old);

  const r = pruneSessions(root);
  assert.deepEqual(r.removed, ['20260810-120000-aaaa.json.999-0.tmp']);
  assert.equal(existsSync(fresh), true, 'a fresh .tmp may belong to a live writer');
});

test('an id this module did not mint is refused rather than written', () => {
  const root = ws();
  const r = saveSession(root, outcome({ messages: conversation() }), { task: 't', id: 'my-session' });
  assert.equal(r.ok, false);
  assert.match(r.error, /newSessionId/);
});

// ───────────────────────────────────────────────────────────────────────────
// The surface
// ───────────────────────────────────────────────────────────────────────────

test('the model gets exactly one READ-ONLY tool, and no resume verb', () => {
  const schemas = sessionToolSchemas();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].function.name, 'list_sessions');
  // A model that can rewrite its own history mid-run is the replay hazard this
  // module exists to prevent. Resume is an operator action, between runs.
  assert.equal(JSON.stringify(schemas).includes('resume'), true, 'the description must point at --resume');
  assert.equal(schemas.some((s) => /^(session_)?resume/.test(s.function.name)), false);
  assert.match(REGISTRATION_SNIPPET, /priorMessages: r\.messages/);
});

test('the one-line summary carries the id you would type to resume', () => {
  const root = ws();
  const saved = saveSession(root, outcome({ messages: conversation(), roundsUsed: 3 }), {
    task: 'a task whose text is far longer than sixty characters so that it has to be clipped somewhere sensible',
  });
  const line = summarizeSession(loadSession(root, saved.id).session);
  assert.ok(line.startsWith(saved.id));
  assert.match(line, /3r · 0 files · 0 cmd · round-cap/);
  assert.match(line, /…$/);
});

test('MAX_SESSIONS is the default cap', () => {
  assert.equal(MAX_SESSIONS, 20);
});
