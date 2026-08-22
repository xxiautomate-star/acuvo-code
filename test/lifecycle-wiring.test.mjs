/**
 * ── ⭐⭐ THE SESSION AND THE AUDIT LOG ARE ACTUALLY REACHABLE ────────────────
 *
 * `lib/session.mjs` (1,005 lines) and `lib/audit.mjs` (446) were finished,
 * documented and covered by their own passing tests — and imported by nothing on
 * the runtime path. Their unit tests proved the modules WORK; nothing proved a
 * user could get at them, and that gap is the whole defect. ENTERPRISE.md:162
 * still lists "no audit log" as an adoption blocker while the module that fixes
 * it sits in lib/.
 *
 * ⚠️ SO EVERY TEST HERE SPAWNS THE REAL BINARY. Importing `bin/acuvo.mjs` is not
 * an option (it calls `main()` on load) and would not answer the question
 * anyway: the question is what a person typing `acuvo` gets, and only argv in /
 * files out can answer it. Assertions are on FILES ON DISK and BYTES ON STDOUT.
 *
 * ── ⭐ AND NONE OF IT SPENDS A COMPLETION ───────────────────────────────────
 * The key is deliberately invalid, so every run dies at the provider — which is
 * exactly the case `session.mjs` was built to record ("a failed session is saved
 * and listable; it is simply not RESUMABLE"). A test suite that needs money or a
 * live network on a fresh clone is a test suite people delete. The resume tests
 * therefore build their session with `saveSession` directly, then check the CLI
 * reads it back; the model is never expected to answer.
 *
 * ⚠️ THE ONE THING THIS FILE CANNOT PROVE is that a resumed conversation makes
 * the model smarter — that costs a completion. It was verified live instead and
 * the transcript is in the change record: three separate processes, and the
 * third answered "The files I created are hello.txt and BYE.txt" about files
 * written by the first two.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { saveSession } from '../lib/session.mjs';
import { parseAuditLog } from '../lib/audit.mjs';

const CLI = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;

/** A key that is well-formed and worthless: the run reaches the provider, is
 *  refused, and returns the failure outcome this file wants to see recorded. */
const DEAD_KEY = 'sk-or-v1-deliberately-invalid-key-for-tests';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'acuvo-lifecycle-'));
}

/**
 * ⚠️ `input: ''` IS LOAD-BEARING. Any invocation that ends up in interactive
 * mode reads stdin; inheriting the runner's hangs `node --test` on a terminal.
 */
function runCli(args, { key = DEAD_KEY } = {}) {
  const env = { ...process.env, NO_COLOR: '1' };
  if (key === null) delete env.OPENROUTER_API_KEY;
  else env.OPENROUTER_API_KEY = key;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
    windowsHide: true,
    env,
  });
}

const auditFiles = (dir) => {
  const d = join(dir, '.acuvo', 'audit');
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.jsonl')) : [];
};
const sessionFiles = (dir) => {
  const d = join(dir, '.acuvo', 'sessions');
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')) : [];
};
const readAudit = (dir) => {
  const names = auditFiles(dir);
  assert.ok(names.length > 0, 'no audit file was written at all');
  return parseAuditLog(readFileSync(join(dir, '.acuvo', 'audit', names[0]), 'utf8'));
};

/**
 * A session that is genuinely resumable, written through the real module so the
 * test never invents a file shape the loader would reject. Returns its id.
 */
function seedResumableSession(dir, task = 'add a healthcheck route') {
  const saved = saveSession(dir, {
    ok: true,
    stage: 'done',
    model: 'stub/model',
    roundsUsed: 3,
    maxRounds: 3,
    stoppedBecause: 'round-cap',
    usage: { cost: 0.0001, total_tokens: 900 },
    executed: [],
    rounds: [],
    verification: { ran: false, passed: null, command: null },
    messages: [
      { role: 'system', content: 'you are a coding agent' },
      { role: 'user', content: task },
      { role: 'assistant', content: 'I wrote src/health.js and ran out of rounds.' },
    ],
  }, { task });
  assert.ok(saved.ok, `the fixture session could not be saved: ${saved.error}`);
  assert.ok(saved.resumable, 'the fixture must be resumable or the resume tests prove nothing');
  return saved.id;
}

/* ────────────────────────────────────────────────────────────────────────────
 * (2) THE AUDIT LOG — ENTERPRISE.md:162
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ an ordinary run leaves a durable audit line AND a session — neither existed before', () => {
  const dir = workspace();
  try {
    const r = runCli(['--dir', dir, '--max-rounds', '1', '--no-run', '--timeout', '10', 'create a.txt containing A']);
    // The provider refuses the key, so the RUN fails — and that is the run most
    // worth recording, because it is the one the user will re-issue.
    assert.strictEqual(r.status, EXIT_FAILED, `expected the dead key to fail the run: ${r.stderr.slice(0, 300)}`);

    assert.strictEqual(auditFiles(dir).length, 1, 'exactly one day-file should exist');
    assert.strictEqual(sessionFiles(dir).length, 1, 'exactly one session should exist');

    const { records, damaged } = readAudit(dir);
    assert.strictEqual(damaged, 0, 'a damaged line means the writer is not append-safe');
    assert.strictEqual(records.length, 1, 'one invocation, one record');
    const rec = records[0];
    assert.strictEqual(rec.v, 1, 'the schema version must be stamped or nobody can read this in two years');
    assert.match(rec.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(rec.taskSha256, /^[0-9a-f]{64}$/, 'the fingerprint proves WHICH task, without storing a 40KB one');
    assert.strictEqual(rec.run.task, 'create a.txt containing A');
    // ⚠️ The shape is report.mjs's toJson, deliberately. If these vanish, someone
    // has re-derived the document and there are now two answers to one question.
    for (const field of ['ok', 'rounds', 'verification', 'changes']) {
      assert.ok(field in rec.run, `the audit record lost toJson's "${field}" field`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️⚠️ the audit line is REDACTED on the way through the CLI, not just in the module', () => {
  const dir = workspace();
  try {
    // A credential in the task is the realistic leak: people paste them in.
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    runCli(['--dir', dir, '--max-rounds', '1', '--no-run', '--timeout', '10', `deploy using token=${secret}`]);
    const raw = readFileSync(join(dir, '.acuvo', 'audit', auditFiles(dir)[0]), 'utf8');
    assert.ok(!raw.includes(secret), 'the audit log recorded a raw credential — this is the failure the whole module exists to prevent');
    assert.match(raw, /redacted/, 'it should say something was removed rather than silently dropping it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ --no-audit and --no-session opt out, and --dry-run writes NEITHER', () => {
  const off = workspace();
  const dry = workspace();
  try {
    runCli(['--dir', off, '--max-rounds', '1', '--no-run', '--timeout', '10', '--no-audit', '--no-session', 'create b.txt']);
    assert.ok(!existsSync(join(off, '.acuvo')), '--no-audit --no-session must leave the workspace untouched');

    /**
     * ⚠️ `--help` promises a dry run "touches nothing". A run log that files a
     * record of a run that did not happen has broken that promise twice over.
     */
    runCli(['--dir', dry, '--max-rounds', '1', '--dry-run', '--timeout', '10', 'create c.txt']);
    assert.ok(!existsSync(join(dry, '.acuvo')), '--dry-run wrote to the workspace');
  } finally {
    rmSync(off, { recursive: true, force: true });
    rmSync(dry, { recursive: true, force: true });
  }
});

test('⚠️ persistence is SILENT on success — a default run says nothing new on stdout', () => {
  const dir = workspace();
  try {
    const r = runCli(['--dir', dir, '--max-rounds', '1', '--no-run', '--timeout', '10', 'create d.txt']);
    assert.strictEqual(sessionFiles(dir).length, 1, 'it should still have saved');
    // The bar is "byte-identical to yesterday" for anyone who passed no new flag.
    assert.ok(!/saved|audit|\.acuvo/i.test(r.stdout), `bookkeeping leaked into stdout: ${JSON.stringify(r.stdout.slice(0, 300))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * (1) SESSION LIFECYCLE — LIST
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ --sessions lists what was saved, and needs NO API key', () => {
  const dir = workspace();
  try {
    const id = seedResumableSession(dir, 'add a healthcheck route');
    // key: null — a machine whose key expired is exactly the machine whose
    // operator wants to know how far the last run got.
    const r = runCli(['--dir', dir, '--sessions'], { key: null });
    assert.strictEqual(r.status, EXIT_OK, `--sessions must not need configuration: ${r.stderr.slice(0, 300)}`);
    assert.ok(r.stdout.includes(id), `the listing did not name the session:\n${r.stdout}`);
    assert.match(r.stdout, /add a healthcheck route/);
    assert.match(r.stdout, /round-cap/, 'why it stopped is the reason you are reading this list');
    assert.match(r.stdout, /--resume/, 'a listing that does not say how to use an id is homework');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--sessions on a fresh workspace says so, rather than printing nothing', () => {
  const dir = workspace();
  try {
    const r = runCli(['--dir', dir, '--sessions'], { key: null });
    assert.strictEqual(r.status, EXIT_OK);
    assert.match(r.stdout, /no runs saved/, 'an empty state must say whether the feature is off or simply unused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️⚠️ --sessions --json is ONE object on stdout and nothing else', () => {
  const dir = workspace();
  try {
    const id = seedResumableSession(dir);
    const r = runCli(['--dir', dir, '--sessions', '--json'], { key: null });
    assert.strictEqual(r.status, EXIT_OK);
    // Parsing IS the assertion: one leading prose line and this throws, which is
    // precisely what `| jq` would do in the user's shell.
    const doc = JSON.parse(r.stdout);
    assert.ok(Array.isArray(doc.sessions), 'the object must carry a sessions array');
    assert.strictEqual(doc.sessions[0].id, id);
    assert.strictEqual(doc.unreadable, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * (1) SESSION LIFECYCLE — RESUME
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ --resume <id> rebuilds the conversation and says plainly that nothing was re-run', () => {
  const dir = workspace();
  try {
    const id = seedResumableSession(dir);
    const r = runCli(['--dir', dir, '--max-rounds', '1', '--no-run', '--timeout', '10', '--resume', id, 'now add a test']);
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(out.includes(`resuming ${id}`), `the resume never happened:\n${out.slice(0, 600)}`);
    // 3 saved messages + the note resumeMessages appends.
    assert.match(out, /4 messages restored/, `the context was not reconstructed:\n${out.slice(0, 600)}`);
    /**
     * ⚠️ THE PROMISE THE USER NEEDS TO SEE. A resume that replayed the earlier
     * run's commands would execute, twice, something they typed once — so the
     * guarantee is stated on screen, not just in a header comment.
     */
    assert.match(out, /nothing re-run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ --continue picks the most recent RESUMABLE run, not merely the most recent', () => {
  const dir = workspace();
  try {
    const wanted = seedResumableSession(dir, 'the one with a conversation');
    /**
     * Then a NEWER run that died before round 1: saved, listable, and holding no
     * conversation at all. Picking it would answer "carry on" with "there is
     * nothing to carry", naming a session the user never chose.
     */
    const dead = saveSession(dir, { ok: false, stage: 'gather', error: 'could not read the workspace' }, { task: 'the newer, dead one' });
    assert.ok(dead.ok && !dead.resumable, 'the fixture must be a saved-but-unresumable run');

    const r = runCli(['--dir', dir, '--max-rounds', '1', '--no-run', '--timeout', '10', '--continue', 'carry on']);
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(out.includes(`resuming ${wanted}`), `--continue chose the wrong session:\n${out.slice(0, 600)}`);
    assert.ok(!out.includes(`resuming ${dead.id}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ --continue with no new instruction re-uses the original task ("carry on")', () => {
  const dir = workspace();
  try {
    seedResumableSession(dir, 'add a healthcheck route');
    const r = runCli(['--dir', dir, '--max-rounds', '1', '--no-run', '--timeout', '10', '--continue']);
    const out = `${r.stdout}${r.stderr}`;
    // ⚠️ Without the original task this drops into INTERACTIVE mode, throws away
    // the messages it just rebuilt, and exits 0 having done nothing.
    assert.ok(!/Type what you want done/.test(out), 'a bare --continue fell through to the chat loop');
    assert.ok(out.includes('resuming'), `--continue did not resume:\n${out.slice(0, 600)}`);
    assert.strictEqual(r.status, EXIT_FAILED, 'it should have gone on to attempt a real round (and been refused by the dead key)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ every refusal on the resume path names what to do INSTEAD', () => {
  /**
   * ── ⚠️⚠️ THESE ASSERTS CARRY THE CHILD'S OUTPUT, AND THAT IS THE POINT ─────
   *
   * This test failed ONCE on 2026-08-15 — `--continue` on an empty workspace
   * exited 1 (EXIT_FAILED) instead of 64 (EXIT_USAGE) — and the same tree
   * passed on the next full run. It did not reproduce in 112 attempts: 40
   * serial, then 72 at 24-way concurrency. So it needs the whole suite's load,
   * which means the next sighting may be weeks away.
   *
   * ⚠️ AND WHEN IT HAPPENED, NOTHING WAS RECORDED. A bare `strictEqual` on an
   * exit code prints "1 !== 64" and throws the child's stderr away — the one
   * artifact that would name the cause. The only path in `bin/acuvo.mjs` that
   * exits 1 here is `die(listed.error, EXIT_FAILED)` when `listSessions` returns
   * `ok: false`, and its error text says which of the two causes it was. That
   * text now reaches the failure message instead of the bin.
   *
   * ⭐ A flake you cannot reproduce is not fixed by staring at it. It is fixed
   * by making the next occurrence explain itself.
   */
  const dir = workspace();
  const shown = (r) => `status=${r.status} signal=${r.signal ?? 'none'}\n--- stderr ---\n${(r.stderr ?? '').slice(0, 800)}\n--- stdout ---\n${(r.stdout ?? '').slice(0, 400)}`;
  try {
    const missing = runCli(['--dir', dir, '--resume', '20200101-000000-zzzz', 'x']);
    assert.strictEqual(missing.status, EXIT_USAGE, shown(missing));
    assert.match(missing.stderr, /--sessions/, 'an unknown id must point at the command that lists the real ones');

    const empty = runCli(['--dir', dir, '--continue', 'x']);
    assert.strictEqual(empty.status, EXIT_USAGE, shown(empty));
    assert.match(empty.stderr, /nothing to continue/);

    const valueless = runCli(['--dir', dir, '--resume']);
    assert.strictEqual(valueless.status, EXIT_USAGE, shown(valueless));
    assert.match(valueless.stderr, /--resume needs the id/);

    const both = runCli(['--dir', dir, '--resume', 'x', '--continue', 'y']);
    assert.strictEqual(both.status, EXIT_USAGE, shown(both));
    assert.match(both.stderr, /they disagree|Pass one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ THE MACHINE CONTRACT — THE FRAGILE PART
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ --resume --json still emits exactly one object, with no banner and no resume line on stdout', () => {
  const dir = workspace();
  try {
    const id = seedResumableSession(dir);
    const r = runCli(['--dir', dir, '--max-rounds', '1', '--no-run', '--timeout', '10', '--json', '--resume', id, 'now add a test']);
    const doc = JSON.parse(r.stdout);
    assert.strictEqual(typeof doc.exitCode, 'number');
    assert.strictEqual(r.status, doc.exitCode, 'the document and the shell must never disagree');
    // The human half is still PRINTED — just not where jq is looking.
    assert.match(r.stderr, /resuming/);
    assert.ok(!/resuming/.test(r.stdout), 'the resume line leaked into the JSON stream');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ the --json guard was NOT weakened: --json alone and --json --parallel are still refused', () => {
  const dir = workspace();
  try {
    const bare = runCli(['--dir', dir, '--json']);
    assert.strictEqual(bare.stdout, '', 'a refusal must reach stdout as zero bytes');
    assert.strictEqual(bare.status, EXIT_USAGE);

    const par = runCli(['--dir', dir, '--json', '--parallel', 'a', 'b', '--timeout', '5']);
    assert.strictEqual(par.stdout, '');
    assert.strictEqual(par.status, EXIT_USAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the new flags are documented in --help, where people actually look', () => {
  const r = runCli(['--help'], { key: null });
  assert.strictEqual(r.status, EXIT_OK);
  for (const flag of ['--sessions', '--resume', '--continue', '--no-audit', '--no-session']) {
    assert.ok(r.stdout.includes(flag), `--help never mentions ${flag}, so nobody will find it`);
  }
  assert.match(r.stdout, /\.acuvo\/audit/, 'the help must say where the run log lands');
});
