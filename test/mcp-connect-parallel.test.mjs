/**
 * ── ⚠️⚠️ SERIAL HANDSHAKES COST UP TO 160 SECONDS OF A TURN ─────────────────
 *
 * `connectServer` waits up to `HANDSHAKE_TIMEOUT_MS` (20s) on a server that
 * never answers, `MAX_SERVERS` is 8, and `runSession` awaited them one after
 * another. That is 160 seconds in which nothing else happens — before the model
 * has been asked a single question. `mcp.mjs` promises that a hosted server
 * being down "costs a line in the transcript, not the run"; serially it cost
 * the run. Found by an adversarial pass timing the real path.
 *
 * ⚠️ THE INTERESTING PART IS NOT THE SPEED. Four properties held by accident in
 * a serial loop and have to be held on purpose in a parallel one, and three of
 * them fail SILENTLY:
 *
 *   1. `mcpConns` in CONFIG order — it builds the tool schemas, the schemas are
 *      part of the cacheable prefix, and a prefix whose byte order depends on
 *      which server answered first misses the cache. That is the 50x discount
 *      this package spent a day earning, lost to a race, with nothing on screen
 *      to say so.
 *   2. Registration the MOMENT a connection exists — a Ctrl-C while server 8 is
 *      still handshaking must still kill the seven already up. Otherwise:
 *      orphans, which this repo has already found on the owner's own laptop.
 *   3. One rejection must not take down seven siblings.
 *   4. Every server ANNOUNCED before any spawn (the audit property `runSession`
 *      documents) — covered where that loop lives.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { connectAllServers } from '../lib/turn.mjs';

const server = (name) => ({ name, command: 'node', args: [`${name}.js`] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('⚠️⚠️ eight slow servers connect CONCURRENTLY, not one after another', async () => {
  /**
   * ⭐ MEASURED AS A COUNT, NOT A STOPWATCH. Wall-clock assertions are the
   * classic flaky test — a loaded machine makes them fail and a fast one makes
   * a serial implementation pass. Peak concurrency is the property itself: it
   * is 1 for a serial loop and 8 for a parallel one, on any machine.
   */
  let inFlight = 0;
  let peak = 0;
  const servers = Array.from({ length: 8 }, (_, i) => server(`s${i}`));
  await connectAllServers(servers, {
    root: '/tmp',
    connectImpl: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(20);
      inFlight -= 1;
      return { ok: true, tools: [] };
    },
  });
  assert.equal(peak, 8, `peak concurrency was ${peak}; a serial loop scores 1 and would spend 8 timeouts back to back`);
});

test('⚠️⚠️ the returned array is in CONFIG order even when the servers answer backwards', async () => {
  /**
   * The cache-prefix property. The slowest server is FIRST in the config and
   * resolves LAST, so an implementation that pushed on completion would return
   * it at the end and reorder the tool schemas — silently, run to run.
   */
  const servers = [server('slow'), server('medium'), server('fast')];
  const delay = { slow: 40, medium: 20, fast: 0 };
  const conns = await connectAllServers(servers, {
    root: '/tmp',
    connectImpl: async (srv) => { await sleep(delay[srv.name]); return { ok: true, tools: [], name: srv.name }; },
  });
  assert.deepEqual(conns.map((c) => c.name), ['slow', 'medium', 'fast'],
    'the connections came back in completion order — the tool schemas, and therefore the cached prefix, would reorder run to run');
});

test('⚠️⚠️ a connection is REGISTERED the moment it exists, not after the last one finishes', async () => {
  /**
   * A Ctrl-C while the last server is still handshaking must still kill the
   * ones already up. So the seven fast servers must be registered while the
   * slow one is still in flight — checked from INSIDE that slow handshake,
   * which is the only moment the distinction is observable.
   */
  const registered = [];
  let seenDuringSlowHandshake = -1;
  const servers = [...Array.from({ length: 7 }, (_, i) => server(`fast${i}`)), server('slow')];
  await connectAllServers(servers, {
    root: '/tmp',
    register: (conn) => registered.push(conn),
    connectImpl: async (srv) => {
      if (srv.name === 'slow') {
        await sleep(40);
        seenDuringSlowHandshake = registered.length;
        return { ok: true, tools: [] };
      }
      return { ok: true, tools: [] };
    },
  });
  assert.equal(seenDuringSlowHandshake, 7,
    `only ${seenDuringSlowHandshake} servers were registered while the last was still handshaking — an interrupt there would orphan the rest`);
  assert.equal(registered.length, 8);
});

test('⚠️⚠️ one THROWING server does not take down the other seven', async () => {
  // Promise.all rejects on the first rejection. connectServer returns
  // {ok:false} today, but an edit that let one throw would turn a single bad
  // server into a dead run — and it would look like the whole feature broke.
  const servers = [...Array.from({ length: 7 }, (_, i) => server(`ok${i}`)), server('boom')];
  const conns = await connectAllServers(servers, {
    root: '/tmp',
    connectImpl: async (srv) => {
      if (srv.name === 'boom') throw new Error('handshake exploded');
      return { ok: true, tools: [{ name: 't' }] };
    },
  });
  assert.equal(conns.length, 8);
  assert.equal(conns.filter((c) => c.ok).length, 7, 'the good servers must survive a bad one');
  const bad = conns[7];
  assert.equal(bad.ok, false);
  assert.match(bad.error, /handshake exploded/, 'the cause must survive, or the failure is undiagnosable');
  assert.deepEqual(bad.tools, [], 'a failed connection must still have a tools array — callers map over it');
});

test('⭐ every server gets exactly one `mcp` event, carrying its name, verdict and tool count', async () => {
  const events = [];
  const conns = await connectAllServers([server('a'), server('b')], {
    root: '/tmp',
    onEvent: (e) => events.push(e),
    connectImpl: async (srv) => (srv.name === 'a'
      ? { ok: true, tools: [{ name: 'x' }, { name: 'y' }] }
      /**
       * ⚠️ NO `tools` KEY AT ALL, and that is the realistic failure shape — a
       * connection that never handshook has no tool list to report. The first
       * version of this test wrote `tools: []` here, and a mutation replacing
       * `conn.ok ? conn.tools.length : 0` with `conn.tools?.length` SURVIVED,
       * because both yield 0 for an empty array. A fixture that is tidier than
       * reality tests the tidiness.
       */
      : { ok: false, error: 'refused' }),
  });
  assert.equal(events.length, 2, 'one event per server, no more and no fewer');
  const byName = Object.fromEntries(events.map((e) => [e.name, e]));
  assert.deepEqual(
    { ...byName.a, type: undefined },
    { type: undefined, name: 'a', ok: true, count: 2, error: undefined },
  );
  assert.equal(byName.b.ok, false);
  assert.equal(byName.b.count, 0, 'a failed server must report 0 tools, never undefined');
  assert.equal(byName.b.error, 'refused');
  assert.equal(conns.length, 2);
});

test('⭐ no servers means no work, no events, and an empty array — not a crash', async () => {
  const events = [];
  for (const input of [[], null, undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const conns = await connectAllServers(input, { root: '/tmp', onEvent: (e) => events.push(e) });
    assert.deepEqual(conns, [], String(input));
  }
  assert.deepEqual(events, []);
});

test('⭐ the io callbacks are all OPTIONAL — a caller that wants only the connections gets them', async () => {
  // `register` and `onEvent` default to no-ops. A missing one must not throw
  // half way through, leaving some servers connected and unregistered.
  const conns = await connectAllServers([server('a')], {
    root: '/tmp',
    connectImpl: async () => ({ ok: true, tools: [] }),
  });
  assert.equal(conns.length, 1);
});
