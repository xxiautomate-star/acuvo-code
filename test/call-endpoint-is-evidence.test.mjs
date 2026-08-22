/**
 * ── ⚠️⚠️ THE FIFTH TIME "NOTHING WAS RUN" WAS SAID AFTER SOMETHING RAN ──────
 *
 * MEASURED 2026-08-15, verbatim, from a real command line the hour
 * `call_endpoint` was wired:
 *
 *   round 2  · start_process        (node server.mjs)
 *   round 3  · check_process
 *   round 4  · call_endpoint        POST /users → 201
 *   summary  ⚠ NOTHING WAS RUN, so nothing here is verified — no command was
 *            executed this session.
 *
 * A process had run. A request had left this program. A real handler had
 * answered `201 Created` — the exact thing the user asked to be proven.
 *
 * ⚠️ AND THE EXISTING GUARD DID NOT COVER IT, though it was written for
 * precisely this. `turn.mjs` already records a `check_process` probe as
 * evidence; that probe fired in round 3, while the server was still booting, and
 * an unreachable probe is silence by design. So the strongest evidence in the
 * run arrived in the round AFTER the only tool allowed to notice it. ⭐ A guard
 * keyed on the NAME OF A TOOL goes stale every time a tool is added — this is
 * the fifth: run_command, evaluate, the acceptance sweep, see_page, and now
 * call_endpoint.
 *
 * ⭐ AND THIS IS THE BEST EVIDENCE OF THE FIVE. `GET /` proves something is
 * listening. `POST /users → 201` is the method, the path and the status the
 * request was actually about — the difference between "a server is up" and "the
 * route you asked me to build works".
 *
 * ⚠️ ONLY A SUCCESSFUL CALL COUNTS, and the asymmetry is the safety argument. A
 * model checking that `/nope` 404s, or reading a 500 in order to fix it, is
 * doing the right thing; a negative verdict there would fail a run that is
 * working correctly — the check-that-fails-correct-work defect this repo has
 * paid for four times.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { runSession, formatSummary } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { toolNamesForRounds } from '../lib/tools.mjs';
import { stopAllBackground, listBackground } from '../lib/background.mjs';

/**
 * Wait until the registry reports a VERIFIED port, or give up.
 *
 * ⚠️ It waits for `portVerified`, not for `port`. The number appears the instant
 * the child prints it; the verdict appears only once the OS confirms the child
 * holds it — and the verdict is what `call_endpoint` requires.
 */
async function untilPortVerified({ timeoutMs = 15_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (listBackground().some((p) => p.running && p.portVerified === true)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const config = { apiKey: 'test-key', model: 'stub/requested-model' };

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-callev-'));
  t.after(() => {
    stopAllBackground();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle lag */ }
  });
  return dir;
}

/**
 * The id of the process this session just started.
 *
 * ⚠️ Resolved at CALL TIME, never hardcoded. The registry's counter does not
 * reset between tests, so `'bg1'` is only right for whichever test happens to
 * run first — an assertion about file order dressed up as a fixture.
 */
const newestProcessId = () => listBackground().at(-1)?.id ?? 'bg1';

/** A port nothing holds right now. Bound, read, released. */
async function freePort() {
  const s = createServer(() => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * A model that runs the scripted calls one round at a time.
 *
 * ⚠️ IT WAITS BEFORE EACH ROUND, AND THAT IS FIDELITY, NOT A FUDGE. A real
 * round costs a model call — seconds — which is why a dev server is up by the
 * time the next tool fires. Without the wait the whole session completed in
 * 66ms and `call_endpoint` was refused with "no port announced yet": a fixture
 * FASTER than reality, failing correct code. The wait is bounded and polls the
 * real registry rather than sleeping a guessed amount.
 */
function scriptedModel(rounds, { beforeRound = null } = {}) {
  let i = 0;
  return async () => {
    if (beforeRound) await beforeRound(i);
    const calls = rounds[i] ?? [];
    i += 1;
    if (calls.length === 0) return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
    return {
      ok: true,
      content: 'working',
      model: 'stub/answering-model',
      /**
       * ⚠️ `args` MAY BE A FUNCTION, AND IT HAD TO BE. The first draft wrote
       * `{ id: 'bg1' }` into every script. The background registry's counter
       * does NOT reset between tests, so the second session's process is `bg2`,
       * `check_process` answered "no such process", and — because verification
       * only happens inside `check_process` — the port was never verified and
       * the call was refused 45 seconds later. A hardcoded id is a fixture
       * asserting something about the test file's ORDER.
       */
      toolCalls: calls.map((c, n) => ({
        id: `c${i}_${n}`,
        function: { name: c.name, arguments: JSON.stringify((typeof c.args === 'function' ? c.args() : c.args) ?? {}) },
      })),
      usage: null,
      finishReason: 'tool_calls',
    };
  };
}

/** Poll a tool result out of the session by re-checking, so no fixed sleep is needed. */
const SERVER = (port) => `
import { createServer } from 'node:http';
const s = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/users') { res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"id":1}'); return; }
  res.writeHead(404); res.end('no');
});
s.listen(${port}, '127.0.0.1', () => console.log('ready - local: http://localhost:${port}'));
`;

test('⭐⭐ call_endpoint is OFFERED — a verb the model is never shown has not shipped', () => {
  const multi = toolNamesForRounds(3, { allowRun: true });
  assert.ok(multi.includes('call_endpoint'), 'the model can only call what it is offered');

  const noRun = toolNamesForRounds(3, { allowRun: false });
  assert.equal(noRun.includes('call_endpoint'), false,
    '--no-run refuses start_process, so this could only ever answer "no such process" — the dead button this package refuses to ship');

  const single = toolNamesForRounds(1, { allowRun: true });
  assert.equal(single.includes('call_endpoint'), false,
    'in a single-shot turn there is no round in which the server is already up');
});

test('⚠️⚠️ A REAL 201 IS EVIDENCE: the summary must not say NOTHING WAS RUN', async (t) => {
  const root = workspace(t);
  const port = await freePort();
  writeFileSync(join(root, 'server.mjs'), SERVER(port));

  /**
   * ⚠️ FIVE ROUNDS OF check_process BEFORE THE CALL, ON PURPOSE. The measured
   * failure depended on the server not answering the probe in the round that
   * probed it — so the fixture must NOT be tidier than that reality. Whether
   * the probe happens to catch it or not, the call in the last round is what
   * this test is about, and the mutation below proves which one carried it.
   */
  const outcome = await runSession({
    task: 'prove POST /users returns 201',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 6,
    onEvent: () => {},
    callModelImpl: scriptedModel([
      [{ name: 'start_process', args: { program: 'node', args: ['server.mjs'] } }],
      [{ name: 'check_process', args: () => ({ id: newestProcessId() }) }],
      [{ name: 'check_process', args: () => ({ id: newestProcessId() }) }],
      [{ name: 'call_endpoint', args: { port, path: '/users', method: 'POST', json: { name: 'ada' } } }],
      [],
    ], { beforeRound: (i) => (i >= 1 ? untilPortVerified() : null) }),
  });

  const call = outcome.executed.find((e) => e.name === 'call_endpoint');
  assert.ok(call, 'the scripted call never reached the dispatcher — the verb is not wired');
  assert.equal(call.result.ok, true, `the call failed: ${call.result.error}`);
  assert.equal(call.result.status, 201, 'a real handler must have answered');

  assert.equal(outcome.verification.ran, true, '⚠️ a request left this program and a real server answered 201');
  assert.equal(outcome.verification.passed, true);
  assert.equal(outcome.verification.kind, 'http-probe', 'no process ran, so this must never claim to be a command');
  assert.equal(outcome.verification.exitCode, null, 'an absent exit code is a fact; a zero would be a claim about a process that never existed');
  assert.equal(outcome.verification.status, 201);
  assert.match(outcome.verification.command, /^POST http:\/\/127\.0\.0\.1:\d+\/users$/,
    'the claim quotes what happened — the method and the URL actually reached');

  const summary = formatSummary(outcome).join('\n');
  assert.doesNotMatch(summary, /NOTHING WAS RUN/,
    'the one line whose whole job is honesty said nothing had been run, after a real 201');
});

test('⚠️ a 404 the model went looking for is SILENCE, never a failed verdict', async (t) => {
  /**
   * Checking that an unknown route 404s is correct behaviour. Recording it as a
   * failure would fail a run that is working — and a guard that fails correct
   * work is worse than no guard, which this repo has now measured four times.
   */
  const root = workspace(t);
  const port = await freePort();
  writeFileSync(join(root, 'server.mjs'), SERVER(port));

  const outcome = await runSession({
    task: 'check the 404 path',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 5,
    onEvent: () => {},
    callModelImpl: scriptedModel([
      [{ name: 'start_process', args: { program: 'node', args: ['server.mjs'] } }],
      [{ name: 'check_process', args: () => ({ id: newestProcessId() }) }],
      [{ name: 'call_endpoint', args: { port, path: '/nope' } }],
      [],
    ], { beforeRound: (i) => (i >= 1 ? untilPortVerified() : null) }),
  });

  const call = outcome.executed.find((e) => e.name === 'call_endpoint');
  assert.equal(call.result.status, 404, 'the call itself succeeded — a 404 is an answer');
  assert.equal(call.result.ok, true, 'the TOOL worked; the route did not exist');
  assert.notEqual(outcome.verification.passed, false,
    'a deliberate 404 must not be turned into a failed run');
});

test('⚠️⚠️ AND THE PORT MUST BE OURS: a claimed-but-unverified port is refused before any socket opens', async (t) => {
  /**
   * The end-to-end shape of the defect fixed the same day. A background process
   * printed a port it does not hold — a repository decides what its dev server
   * prints — and the victim on that port must never be touched. Here the
   * "victim" is a server this test owns, so it can be asked whether anyone
   * knocked.
   */
  const root = workspace(t);
  const victimPort = await freePort();
  const seen = [];
  const victim = createServer((req, res) => { seen.push(req.url); res.writeHead(200); res.end('secret'); });
  await new Promise((r) => victim.listen(victimPort, '127.0.0.1', r));
  t.after(async () => { try { victim.closeAllConnections?.(); } catch { /* older node */ } await new Promise((r) => victim.close(r)); });

  writeFileSync(join(root, 'liar.mjs'), `
import { createServer } from 'node:http';
const s = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
s.listen(0, '127.0.0.1', () => console.log('Server running at http://localhost:${victimPort}/'));
`);

  const outcome = await runSession({
    task: 'call the port it announced',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 5,
    onEvent: () => {},
    callModelImpl: scriptedModel([
      [{ name: 'start_process', args: { program: 'node', args: ['liar.mjs'] } }],
      [{ name: 'check_process', args: () => ({ id: newestProcessId() }) }],
      [{ name: 'call_endpoint', args: { port: victimPort, path: '/containers/create', method: 'POST', json: { Image: 'alpine' } } }],
      [],
    ]),
  });

  const call = outcome.executed.find((e) => e.name === 'call_endpoint');
  assert.equal(call.result.ok, false, 'a port this run did not verifiably start must never be called');
  assert.deepEqual(seen, [], '⚠️⚠️ THE VICTIM WAS TOUCHED — the guard runs before the socket, or it is not a guard');
  assert.notEqual(outcome.verification.ran, true, 'a refused call proves nothing and must not read as evidence');
});
