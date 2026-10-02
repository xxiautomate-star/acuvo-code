/**
 * ── ⭐⭐⭐ WHAT THIS SUITE GUARDS: TWO DEFECTS FOUND BY TYPING, NOT BY READING ─
 *
 * MEASURED 2026-09-19 at the real prompt, against 0.6.22:
 *
 *     › /config     /config is not a command.
 *     › /approve    /approve is not a command.
 *     › /rewind     /rewind is not a command.
 *
 * while `acuvo config`, `acuvo rewind` and `--approve` had all worked from the
 * command line for weeks. The four questions the product is BUILT AROUND were
 * invisible from the one place a person sits; the ASK-or-ACT mode was fixed for
 * the life of a session; and the undo — the thing you reach for at the exact
 * moment something went wrong — cost you the conversation, because the only way
 * to it was to leave.
 *
 * ── ⚠️⚠️⚠️ AND THE SECOND ONE IS WORSE, BECAUSE IT WAS A SAFETY MODE ────────
 *
 * Measured in the product, same day, with NO change of mine in the path:
 *
 *     acuvo --approve always "replace the entire contents of math.mjs …"
 *       → ✎ replaced math.mjs  (18 bytes · was 199)
 *
 * 90% of a file destroyed under the mode whose entire meaning is "ask me about
 * every write", with nothing asked and nothing refused. `diff-preview.mjs` had
 * computed the right verdict — `{ required: true, satisfiable: false, blocked:
 * true }`, under a comment calling it *"THE ONE FAIL-CLOSED BRANCH"* — and
 * `write-approval.mjs` threw it away one line later, because `!satisfiable` sat
 * in the same condition as `!required` and both returned `allowed: true`.
 *
 * ⭐ 117 TESTS ACROSS FIVE APPROVAL SUITES WERE GREEN THE WHOLE TIME. Every one
 * of them built its own collaborators, so none could see a verdict being
 * discarded by the module that consumes it. That is why section 4 below spawns
 * `bin/acuvo.mjs` for real: a reachability claim that a test makes about its own
 * fixtures is a claim about the fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSlashCommand, SLASH_COMMANDS } from '../lib/slash.mjs';
import { runChat } from '../lib/chat.mjs';
import { createWriteApprover, refusedWriteResult } from '../lib/write-approval.mjs';
import { APPROVE_MODES } from '../lib/diff-preview.mjs';

const BIN = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));

/** One place that knows what "it said nothing useful" looks like. */
const said = (result) => (result.output ?? []).join('\n');

// ── 1. THE REGISTRY AND THE SWITCH CANNOT DRIFT ─────────────────────────────

test('every command in the registry has an implementation', () => {
  for (const c of SLASH_COMMANDS) {
    const out = said(runSlashCommand({ name: c.name, args: '' }, {}));
    assert.ok(
      !out.includes('listed but not implemented'),
      `/${c.name} is advertised by /help and falls through the switch`,
    );
  }
});

test('the three new commands are registered and appear in /help', () => {
  const names = SLASH_COMMANDS.map((c) => c.name);
  for (const want of ['config', 'approve', 'rewind']) {
    assert.ok(names.includes(want), `/${want} is missing from the registry`);
  }
  const help = said(runSlashCommand({ name: 'help', args: '' }, {}));
  for (const want of ['/config', '/approve', '/rewind']) {
    assert.ok(help.includes(want), `${want} is implemented but /help never names it`);
  }
});

test('⚠️ `--help` NAMES EVERY COMMAND, because it held a hand-typed copy of this list', async () => {
  // ⚠️ `USAGE` is a joined STRING, not the array the source literal starts as.
  const { USAGE } = await import('../lib/cli-args.mjs');
  const help = Array.isArray(USAGE) ? USAGE.join('\n') : String(USAGE);
  for (const c of SLASH_COMMANDS) {
    assert.ok(help.includes(`/${c.name}`), `--help does not mention /${c.name}`);
  }
});

// ── 2. `/config`, `/approve`, `/rewind` — THE WORDING ───────────────────────

test('/config prints what the provider gives it, and says so honestly when there is none', () => {
  const lines = ['The four questions — what this run will do, and who decided it:', '', '  done  verified'];
  const out = said(runSlashCommand({ name: 'config', args: '' }, { config: () => lines }));
  assert.ok(out.includes('The four questions'), out);
  assert.ok(out.includes('done  verified'), out);

  const bare = said(runSlashCommand({ name: 'config', args: '' }, {}));
  assert.ok(bare.includes('not available in this session'), bare);
});

test('⚠️ /config does not pad a blank line into trailing whitespace', () => {
  const out = runSlashCommand({ name: 'config', args: '' }, { config: () => ['a', '', 'b'] });
  for (const line of out.output) assert.equal(line, line.replace(/\s+$/, ''), JSON.stringify(line));
});

test('a bare /approve READS the mode and changes nothing', () => {
  let setTo = 'untouched';
  const out = said(runSlashCommand({ name: 'approve', args: '' }, {
    approve: (next) => {
      if (next !== undefined) { setTo = next; return { ok: true, mode: next, modes: APPROVE_MODES }; }
      return { mode: 'auto', source: 'built-in default', modes: APPROVE_MODES };
    },
  }));
  assert.equal(setTo, 'untouched', 'a bare /approve must not set anything');
  assert.ok(out.includes('auto'), out);
  assert.ok(out.includes('always'), 'the three words are not guessable — the menu must be printed');
});

test('⭐ /approve <mode> sets it, and the PREVIOUS value is printed', () => {
  let mode = 'auto';
  const ctx = {
    approve: (next) => {
      if (next === undefined) return { mode, modes: APPROVE_MODES };
      if (!APPROVE_MODES.includes(next)) return { ok: false, modes: APPROVE_MODES, error: `/approve ${next} is not a mode.` };
      const previous = mode;
      mode = next;
      return { ok: true, mode, previous, modes: APPROVE_MODES };
    },
  };
  const out = said(runSlashCommand({ name: 'approve', args: 'always' }, ctx));
  assert.equal(mode, 'always');
  assert.ok(out.includes('auto') && out.includes('always'), out);

  // ⚠️ Typing the mode you are already in must SAY so, or the keystroke reads as a change.
  const again = said(runSlashCommand({ name: 'approve', args: 'always' }, ctx));
  assert.ok(/already in force|nothing changed/.test(again), again);
});

test('⚠️ /approve <nonsense> refuses AND names the three modes', () => {
  const out = said(runSlashCommand({ name: 'approve', args: 'yolo' }, {
    approve: (next) => (next === undefined
      ? { mode: 'auto', modes: APPROVE_MODES }
      : { ok: false, modes: APPROVE_MODES, error: `/approve ${next} is not a mode.` }),
  }));
  assert.ok(out.includes('not a mode'), out);
  for (const m of APPROVE_MODES) assert.ok(out.includes(m), `the refusal withheld "${m}": ${out}`);
});

test('/rewind bare lists, /rewind <id> acts, and a FLAG is refused rather than passed on', () => {
  const seen = [];
  const ctx = { rewind: (id) => { seen.push(id); return { lines: [`called with ${String(id)}`] }; } };

  assert.ok(said(runSlashCommand({ name: 'rewind', args: '' }, ctx)).includes('called with null'));
  assert.ok(said(runSlashCommand({ name: 'rewind', args: '20260919-x' }, ctx)).includes('called with 20260919-x'));

  /**
   * ⚠️ `--force` OVERRIDES THE ONE REFUSAL THAT PROTECTS A HAND EDIT. It is not
   * reachable from the prompt on purpose, and it must not be silently swallowed
   * as an id either — that would read as "nothing matched" for a flag that does
   * something real one command away.
   */
  const forced = said(runSlashCommand({ name: 'rewind', args: '--force' }, ctx));
  assert.equal(seen.length, 2, '--force must not reach the provider');
  assert.ok(forced.includes('not a flag') && forced.includes('acuvo rewind'), forced);
});

// ── 3. THE SAFETY MODE THAT FAILED OPEN ─────────────────────────────────────

/** A destructive write: an existing file this run did not create, gutted. */
const DESTRUCTIVE = {
  path: 'src/server.js',
  before: 'export function serve() {\n  return listen(8080);\n}\n'.repeat(12),
  after: 'x',
  exists: true,
};

test('⚠️⚠️⚠️ --approve always with no terminal REFUSES the write — it used to perform it', async () => {
  const approver = createWriteApprover({ ask: null, isInteractive: false, env: {}, flag: 'always' });
  const decision = await approver.approve(DESTRUCTIVE);
  assert.equal(decision.allowed, false, 'the mode whose meaning is "ask me about every write" wrote without asking');
  assert.equal(decision.blocked, true);
  assert.equal(decision.reviewed, false, 'nothing was reviewed — claiming it was is the lie the counters exist to avoid');
  assert.match(decision.reason, /nobody here to ask/);
});

test('⭐ AND THE DEFAULT STILL FAILS OPEN — a gate that breaks CI gets switched off and protects nobody', async () => {
  for (const flag of [null, 'auto']) {
    const approver = createWriteApprover({ ask: null, isInteractive: false, env: {}, flag });
    const decision = await approver.approve(DESTRUCTIVE);
    assert.equal(decision.allowed, true, `flag=${flag} must keep writing unattended`);
    assert.notEqual(decision.blocked, true);
  }
});

test('⭐ never still writes, and an INTERACTIVE always still ASKS rather than blocking', async () => {
  const off = createWriteApprover({ ask: null, isInteractive: false, env: {}, flag: 'never' });
  assert.equal((await off.approve(DESTRUCTIVE)).allowed, true);

  const asked = [];
  const on = createWriteApprover({
    ask: (q) => { asked.push(q); return 'y'; },
    isInteractive: true,
    env: {},
    flag: 'always',
    show: () => {},
  });
  const decision = await on.approve(DESTRUCTIVE);
  assert.equal(asked.length, 1, 'a terminal IS here — it must ask, not block');
  assert.equal(decision.allowed, true);
  assert.equal(decision.reviewed, true);
});

test('⚠️⚠️ THE BATCH DOOR HAD THE SAME HOLE, and it waves through forty files at once', async () => {
  const approver = createWriteApprover({ ask: null, isInteractive: false, env: {}, flag: 'always' });
  const verdict = await approver.approveMany([
    { path: 'notes/scratch.md', before: null, after: 'hi', exists: false },
    DESTRUCTIVE,
  ]);
  assert.equal(verdict.allowed, false, 'one blocked file in a batch is a blocked batch');
  assert.equal(verdict.blocked, true);
});

test('⚠️ the model is told the run is MISCONFIGURED, never that a person said no', () => {
  const blocked = refusedWriteResult('src/server.js', { blocked: true, reason: 'there is nobody here to ask' });
  assert.equal(blocked.ok, false);
  assert.ok(!/declined by the person/.test(blocked.error), blocked.error);
  assert.match(blocked.error, /nobody here to ask/);

  // The human refusal is untouched: it must still read as a decision, not a fault.
  const declined = refusedWriteResult('src/server.js');
  assert.match(declined.error, /declined by the person running this/);
});

// ── 4. REACHABILITY — THE REAL BINARY, NOT A FIXTURE ────────────────────────

/**
 * ⭐⭐ THIS IS THE ONLY TEST HERE THAT COULD HAVE CAUGHT THE ORIGINAL DEFECT.
 * The commands were PURE and fully tested in `slash-commands.test.mjs` before
 * they existed at the prompt, because `runSlashCommand` takes its providers as
 * an argument — so a suite can pass with every provider supplied by the suite
 * and nothing supplying them in production. This spawns `bin/acuvo.mjs`, pipes
 * three commands into it, and reads what a person would have seen.
 *
 * ⚠️ IT SPENDS NOTHING. Every command asserted here answers locally; none of
 * them reaches a model, and the session exits before a task is ever sent.
 */
test('⭐⭐ the SHIPPED binary answers /config, /approve and /rewind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-reach-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    const run = spawnSync(process.execPath, [BIN], {
      cwd: dir,
      // ⚠️ `/config` TWICE, DELIBERATELY: once before `/approve` and once after.
      // The second one is the assertion that a value set at the prompt is not
      // still labelled "built-in default".
      input: '/config\n/approve\n/approve always\n/approve nonsense\n/config\n/rewind\nexit\n',
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ACUVO_OFFLINE: '1' },
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;

    for (const dead of ['/config is not a command', '/approve is not a command', '/rewind is not a command']) {
      assert.ok(!out.includes(dead), `${dead}\n\n${out}`);
    }
    for (const dead of ['The configuration is not available', 'The approval mode is not available', 'The undo is not available']) {
      assert.ok(!out.includes(dead), `a provider is missing from bin/acuvo.mjs: ${dead}\n\n${out}`);
    }

    assert.match(out, /The four questions/, out);
    assert.match(out, /precedence: command-line flag/, out);
    assert.match(out, /approve\s+auto/, out);
    assert.match(out, /auto → always/, out);
    assert.match(out, /not a mode/, out);
    /**
     * ⚠️ `/config` AFTER `/approve` MUST NAME THE NEW SOURCE. A value set at the
     * prompt still labelled "built-in default" is the same class of lie as a
     * mode that prints but does not bite.
     */
    assert.match(out, /always\s+← set with \/approve, this session/, out);
    assert.match(out, /no checkpoints|checkpoints, newest first/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. THE LAST THREE DOORS — /doctor, /spend, /resume ──────────────────────

/**
 * ── ⭐⭐⭐ WHY THIS SECTION IS NOT JUST "THREE MORE COMMANDS" ────────────────
 *
 * MEASURED 2026-09-19 at the real prompt, 0.6.22, after `/config`, `/approve`
 * and `/rewind` had already landed:
 *
 *     › /doctor    /doctor is not a command.
 *     › /spend     /spend is not a command.
 *     › /resume    /resume is not a command.
 *
 * The note left behind said closing these needed an ASYNC dispatcher, because
 * `runSlashCommand` is synchronous by contract, `slash.mjs` is pure, and
 * `--doctor` probes the network. The constraint was real; the conclusion was
 * not, and measuring the three SEPARATELY is what shows why:
 *
 *     /spend    summariseSpend(readAuditFiles(root))   SYNC — a directory read
 *     /resume   listSessions · resumeMessages          SYNC — a directory read
 *     /doctor   runDoctor                              async — network probes
 *
 * ⭐ TWO OF THE THREE NEEDED A PROVIDER, NOT A MECHANISM — the same shape
 * `readJournal` has behind `/rewind`. The third used the `effect` seam that has
 * been in this module since the day it was written, so `runSlashCommand` is
 * still synchronous, still pure, and the nine commands that did not need to
 * change did not change. The tests below pin BOTH halves of that: the purity,
 * and the fact that the effect actually reaches the loop that honours it.
 */

test('/spend, /resume and /doctor are synchronous and pure — no provider, no crash, an honest answer', () => {
  for (const name of ['spend', 'resume', 'doctor']) {
    const r = runSlashCommand({ name, args: '' }, {});
    assert.ok(!(r instanceof Promise), `/${name} returned a promise — runSlashCommand is synchronous by contract`);
    assert.match(said(r), /not available in this session/, `/${name}: ${said(r)}`);
    assert.equal(r.effect, undefined, `/${name} claimed an effect with no provider to honour it`);
  }
});

test('⭐ /doctor CALLS NOTHING — it returns the effect and chat.mjs owns the await', () => {
  let called = 0;
  const r = runSlashCommand({ name: 'doctor', args: '' }, { doctor: () => { called += 1; return 'x'; } });
  assert.equal(called, 0, 'slash.mjs invoked an async provider — the purity guarantee is gone');
  assert.equal(r.effect, 'doctor');
  assert.match(said(r), /checking this machine/, said(r));
});

test('a bare /resume LISTS and restores nothing; an id carries the messages back as an effect', () => {
  const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const listed = runSlashCommand({ name: 'resume', args: '' }, {
    resume: (id) => {
      assert.equal(id, null, 'a bare /resume must not name a run for the user');
      return { lines: ['20260919-000000-aaaa · finished — a task'] };
    },
  });
  assert.equal(listed.effect, undefined, 'listing must not swap the conversation');
  assert.match(said(listed), /20260919-000000-aaaa/);

  const one = runSlashCommand({ name: 'resume', args: '20260919-000000-aaaa' }, {
    resume: (id) => ({ id, lines: ['resumed it'], messages }),
  });
  assert.equal(one.effect, 'resume');
  assert.deepEqual(one.messages, messages);
});

/**
 * ⚠️ THE ERROR CASE IS THE ONE THAT COULD EMPTY A CONVERSATION. A provider that
 * answers a bad id with a line and no messages must produce NO effect — an
 * effect carrying `undefined` would swap the history for nothing while the
 * terminal printed an error about something else entirely.
 */
test('⚠️ a /resume that failed carries no effect, so the history cannot be swapped for nothing', () => {
  for (const bad of [{ lines: ['no such run'] }, { lines: ['x'], messages: [] }, { lines: ['x'], messages: 'nope' }]) {
    const r = runSlashCommand({ name: 'resume', args: 'whatever' }, { resume: () => bad });
    assert.equal(r.effect, undefined, JSON.stringify(bad));
  }
});

test('/resume refuses a flag rather than treating it as an id', () => {
  const out = said(runSlashCommand({ name: 'resume', args: '--continue' }, { resume: () => assert.fail('must not read anything') }));
  assert.match(out, /takes a run id, not a flag/, out);
  assert.match(out, /acuvo --continue/, out);
});

// ── 6. THE EFFECTS REACH THE LOOP THAT HONOURS THEM ─────────────────────────

/**
 * ⭐⭐ THIS IS THE HALF `slash-commands.test.mjs` STRUCTURALLY CANNOT SEE.
 * `runSlashCommand` returns a DESCRIPTION; a suite that asserts the description
 * has proved nothing about whether anybody acts on it. `effect: 'resume'` and
 * `effect: 'doctor'` are both new words, and a loop that ignores an unknown
 * effect prints the right sentence and does nothing — which is exactly the
 * "dead button wearing a working button's coat" this repo keeps paying for.
 *
 * So these drive the REAL `runChat` with a fake `runOne` that reports the
 * history it was handed.
 */
function pipedChat({ lines, slashContext, runOne }) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.text = '';
  output.on('data', (c) => { output.text += c.toString(); });
  input.end(lines.map((l) => `${l}\n`).join(''));
  return { output, run: runChat({ runOne, render: () => {}, input, output, slashContext }) };
}

test('⭐⭐ /resume <id> REPLACES the live conversation, and the next turn is sent with it', async () => {
  const restored = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'earlier reply' }];
  const seen = [];
  const { output, run } = pipedChat({
    lines: ['/resume 20260919-000000-aaaa', 'carry on', 'exit'],
    slashContext: { resume: () => ({ lines: ['resumed it'], messages: restored }) },
    runOne: async (task, history) => {
      seen.push({ task, history });
      return { ok: true, messages: [...(history ?? []), { role: 'user', content: task }] };
    },
  });
  await run;
  assert.equal(seen.length, 1, output.text);
  assert.deepEqual(seen[0].history, restored,
    'the restored messages never reached runOne — effect: "resume" is a dead word in chat.mjs');
});

test('⭐⭐ /doctor AWAITS the provider and prints what it returns', async () => {
  let calls = 0;
  const { output, run } = pipedChat({
    lines: ['/doctor', 'exit'],
    slashContext: {
      doctor: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return 'Acuvo Code — doctor\n  live    node';
      },
    },
    runOne: async () => assert.fail('/doctor must not cost a turn'),
  });
  await run;
  assert.equal(calls, 1, 'the doctor provider was never called');
  assert.match(output.text, /live {4}node/, output.text);
});

test('⚠️ a doctor that throws prints a line, not a stack trace over the conversation', async () => {
  const { output, run } = pipedChat({
    lines: ['/doctor', 'exit'],
    slashContext: { doctor: async () => { throw new Error('getaddrinfo ENOTFOUND'); } },
    runOne: async () => assert.fail('/doctor must not cost a turn'),
  });
  await run;
  assert.match(output.text, /could not be completed: getaddrinfo ENOTFOUND/, output.text);
});

// ── 7. THE SHIPPED BINARY ANSWERS ALL THREE ─────────────────────────────────

/**
 * ⭐⭐ THE SAME ARGUMENT AS SECTION 4, FOR THE SAME REASON: every test above
 * supplies its own providers, so all of them would stay green with
 * `bin/acuvo.mjs` wiring none. This spawns the binary.
 *
 * ⚠️ `ACUVO_OFFLINE=1` — `/doctor` is the one command here that would otherwise
 * leave the machine, and a suite that probes six endpoints is a suite people
 * stop running. The report still renders; the probes report "could not check".
 */
test('⭐⭐ the SHIPPED binary answers /doctor, /spend and /resume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-doors-'));
  try {
    const run = spawnSync(process.execPath, [BIN], {
      cwd: dir,
      input: '/spend\n/resume\n/doctor\nexit\n',
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, ACUVO_OFFLINE: '1' },
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    for (const dead of ['/doctor is not a command', '/spend is not a command', '/resume is not a command']) {
      assert.ok(!out.includes(dead), `${dead}\n\n${out}`);
    }
    assert.ok(!out.includes('listed but not implemented'), out);
    for (const dead of ['The doctor is not available', 'Spend for this workspace is not available', 'Earlier runs is not available']) {
      assert.ok(!out.includes(dead), `a provider is missing from bin/acuvo.mjs: ${dead}\n\n${out}`);
    }
    // /spend on a workspace that has never run says so, and names the file it reads.
    assert.match(out, /\.acuvo\/audit/, out);
    // /resume on a workspace with no sessions says which, not just "none".
    assert.match(out, /no runs saved in this workspace yet/, out);
    // /doctor rendered the real report, not a stub.
    assert.match(out, /Acuvo Code — doctor/, out);
    assert.match(out, /MODEL CHAIN/, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
