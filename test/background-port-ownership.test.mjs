/**
 * ── ⚠️⚠️ THE PORT CAME FROM THE THING WE WERE DEFENDING AGAINST ─────────────
 *
 * `background.mjs` said, in its own header, that its probe was safe because it
 * "only ever connects to a port this module started itself". `detectPort` said
 * it was exported "because 'we only probe a port we started' is a security
 * claim, and it is only true if this is testable."
 *
 * ⚠️⚠️ THE CLAIM WAS FALSE, AND TESTING `detectPort` COULD NEVER HAVE SHOWN IT.
 * The function was correct. Its INPUT was the child's own STDOUT — so the
 * repository somebody cloned chose the number. Measured end to end 2026-08-15,
 * against the real module and the real OS:
 *
 *   a decoy bound 4322 and printed "Docker daemon on port 2375"
 *     → listBackground() reported {"port":2375}
 *     → check_process reported "it is listening: HTTP 200 on
 *       http://localhost:2375/"   ← the VICTIM's status, read back to the model
 *     → VICTIM_HIT
 *
 * Docker's API on 2375 is unauthenticated and will bind `/` into a container.
 *
 * ⭐ THE FIX IS TO ASK THE OPERATING SYSTEM, not to parse harder. `detectPort`
 * still returns a CLAIM; `verifyPortOwner` turns it into a fact by matching the
 * listening pid against the process this run started, or one of its
 * descendants. With the guard in place the same run reports `portVerified:
 * false`, probes nothing, and the victim is touched 0 times — while an honest
 * server on 4321 is still verified and still probed (HTTP 200).
 *
 * ⭐⭐ THE LESSON IS BIGGER THAN THE BUG. The guard existed, was documented, was
 * tested, and was checking a fact the attacker supplied. A test of the parser
 * is not a test of the claim the parser is used to make.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  verifyPortOwner, descendantsOf, detectPort,
  startBackground, checkBackground, stopAllBackground, listBackground,
  PORT_OWNER_TIMEOUT_MS,
} from '../lib/background.mjs';

const made = [];
after(() => {
  stopAllBackground();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-portown-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"po","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return { root, dryRun: false, readFile: () => null };
}

async function until(fn, { timeoutMs = 15_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * A fake OS. `listeners` maps port → owning pid; `table` is [pid, parentPid].
 *
 * ⚠️ It emits the REAL output shapes — `netstat -ano` rows with their leading
 * whitespace and an IPv6 `[::]:` form, `wmic ... /format:csv` with its Node
 * column. A fixture tidier than reality is how a parser passes a test and fails
 * a machine, and this package has been bitten by exactly that twice.
 */
function fakeOs({ listeners = {}, table = [], platform = 'win32', fail = null } = {}) {
  return (file, args) => {
    if (fail === file) return { status: 1, stdout: '' };
    if (file === 'netstat') {
      const rows = Object.entries(listeners).flatMap(([port, pid], i) => ([
        i % 2 === 0
          ? `  TCP    0.0.0.0:${port}         0.0.0.0:0              LISTENING       ${pid}`
          : `  TCP    [::]:${port}            [::]:0                 LISTENING       ${pid}`,
        `  TCP    127.0.0.1:${Number(port) + 40000}       127.0.0.1:5555         ESTABLISHED     ${pid}`,
      ]));
      return { status: 0, stdout: ['\r\nActive Connections\r\n', '  Proto  Local Address          Foreign Address        State           PID', ...rows, ''].join('\r\n') };
    }
    if (file === 'lsof') {
      const want = Number(String(args[0]).replace('-iTCP:', ''));
      const pid = listeners[want];
      return { status: 0, stdout: pid === undefined ? '' : `p${pid}\n` };
    }
    if (file === 'wmic') {
      const rows = table.map(([pid, ppid]) => `HOSTNAME,${ppid},${pid}\r`);
      return { status: 0, stdout: ['Node,ParentProcessId,ProcessId\r', ...rows, '\r'].join('\r\n') };
    }
    if (file === 'ps') {
      return { status: 0, stdout: table.map(([pid, ppid]) => `  ${pid}  ${ppid}`).join('\n') + '\n' };
    }
    throw new Error(`unexpected ${file}`);
  };
}

test('⚠️⚠️ THE ATTACK: a port the child NAMED but does not HOLD is refused', () => {
  // The decoy prints "Docker daemon on port 2375" while 2375 belongs to
  // something else entirely — here pid 999, our child is pid 100.
  const v = verifyPortOwner(2375, 100, {
    spawnImpl: fakeOs({ listeners: { 2375: 999 }, table: [[100, 1]] }),
    platform: 'win32',
  });
  assert.equal(v.owned, false, 'a port owned by a stranger must never be probed');
  assert.equal(v.verified, true, 'the OS answered, so this is a fact and not a shrug');
  assert.equal(v.owner, 999);
  assert.match(v.why, /did NOT start/);
});

test('⭐ AND THE HONEST CASE STILL WORKS — the process itself holds the port', () => {
  const v = verifyPortOwner(4321, 100, {
    spawnImpl: fakeOs({ listeners: { 4321: 100 }, table: [[100, 1]] }),
    platform: 'win32',
  });
  assert.equal(v.owned, true);
  assert.equal(v.owner, 100);
});

test('⭐⭐ A GRANDCHILD COUNTS — `npm run dev` forks, and an exact-pid rule would refuse every real dev server', () => {
  /**
   * npm (100) → node (200) → the actual server (300), which is what binds.
   * If this were rejected the guard would break correct work, get switched off,
   * and the hole would be back with a ceremony in front of it.
   */
  const v = verifyPortOwner(3000, 100, {
    spawnImpl: fakeOs({ listeners: { 3000: 300 }, table: [[200, 100], [300, 200]] }),
    platform: 'win32',
  });
  assert.equal(v.owned, true, 'a descendant of the process we started IS the process we started');
  assert.equal(v.owner, 300);
});

test('⚠️⚠️ IT DEGRADES TO "COULD NOT CHECK", NEVER TO "FINE"', () => {
  // netstat missing, sandboxed, or too slow. The answer must be a refusal —
  // "I could not check it" and "it is fine" are different answers.
  const v = verifyPortOwner(2375, 100, {
    spawnImpl: fakeOs({ listeners: { 2375: 999 }, fail: 'netstat' }),
    platform: 'win32',
  });
  assert.equal(v.owned, false);
  assert.equal(v.verified, false, 'an unanswerable question is not a yes');
  assert.match(v.why, /could not ask this machine/);

  const threw = verifyPortOwner(2375, 100, {
    spawnImpl: () => { throw new Error('ENOENT'); },
    platform: 'win32',
  });
  assert.equal(threw.owned, false);
  assert.equal(threw.verified, false);
});

test('⚠️ a process table that cannot be read yields NO family, so the check refuses rather than widens', () => {
  const family = descendantsOf(100, { spawnImpl: () => { throw new Error('nope'); }, platform: 'win32' });
  assert.equal(family.size, 0, 'a guess that widened the family would widen the hole');

  // And with the table gone, a grandchild-owned port is refused rather than waved through.
  const v = verifyPortOwner(3000, 100, {
    spawnImpl: fakeOs({ listeners: { 3000: 300 }, table: [[300, 100]], fail: 'wmic' }),
    platform: 'win32',
  });
  assert.equal(v.owned, false);
});

test('⚠️ the family is walked to a FIXED POINT — the process table arrives in no useful order', () => {
  /**
   * The grandchild row comes FIRST, before the row that makes its parent ours.
   * One sweep misses it, and a missed descendant is a real dev server reported
   * as an impostor.
   */
  const outOfOrder = [[400, 300], [300, 200], [200, 100]];
  const family = descendantsOf(100, { spawnImpl: fakeOs({ table: outOfOrder }), platform: 'win32' });
  assert.deepEqual([...family].sort((a, b) => a - b), [200, 300, 400]);
  assert.equal(family.has(100), false, 'the root is not its own descendant');
});

test('⭐ POSIX reads lsof, not netstat', () => {
  const owned = verifyPortOwner(5173, 100, {
    spawnImpl: fakeOs({ listeners: { 5173: 100 }, table: [[100, 1]], platform: 'linux' }),
    platform: 'linux',
  });
  assert.equal(owned.owned, true);

  const stranger = verifyPortOwner(5173, 100, {
    spawnImpl: fakeOs({ listeners: { 5173: 999 }, table: [[100, 1]], platform: 'linux' }),
    platform: 'linux',
  });
  assert.equal(stranger.owned, false);
  assert.equal(stranger.owner, 999);
});

test('nothing listening is a plain no, and it is VERIFIED — a booting server is the normal case', () => {
  const v = verifyPortOwner(3000, 100, { spawnImpl: fakeOs({ listeners: {}, table: [[100, 1]] }), platform: 'win32' });
  assert.equal(v.owned, false);
  assert.equal(v.verified, true);
  assert.match(v.why, /nothing is listening/);
});

test('a pid we never got, and a port that is not a port, are both refused', () => {
  const noPid = verifyPortOwner(3000, null, { spawnImpl: () => { throw new Error('must not be called'); }, platform: 'win32' });
  assert.equal(noPid.owned, false);
  assert.equal(noPid.verified, false, 'we could not check, so we must not claim to have');

  for (const bad of [0, -1, 70000, 'nope', null, NaN]) {
    const v = verifyPortOwner(bad, 100, { spawnImpl: () => { throw new Error('must not be called'); }, platform: 'win32' });
    assert.equal(v.owned, false, `${bad} must not be owned`);
  }
});

test('⚠️ the timeout is a real number and is passed to the OS call — a hung netstat must not hang check_process', () => {
  assert.equal(typeof PORT_OWNER_TIMEOUT_MS, 'number');
  assert.ok(PORT_OWNER_TIMEOUT_MS > 0 && PORT_OWNER_TIMEOUT_MS <= 15_000, 'a check_process round waits on this');
  let seen = null;
  verifyPortOwner(3000, 100, {
    spawnImpl: (f, a, o) => { seen = o?.timeout; return { status: 0, stdout: '' }; },
    platform: 'win32',
    timeoutMs: 1234,
  });
  assert.equal(seen, 1234, 'a timeout that is accepted and dropped is not a timeout');
});

test('⭐ detectPort is unchanged — it still reads the claim, it is just no longer trusted alone', () => {
  assert.equal(detectPort('ready - local: http://localhost:4321'), 4321);
  assert.equal(detectPort('Docker daemon on port 2375'), 2375, 'the parser is correct; the INPUT was the problem');
});

/* ────────────────────────── the live path, end to end ───────────────────── */

const LIAR = `
import { createServer } from 'node:http';
const s = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
s.listen(0, '127.0.0.1', () => { console.log('Server running at http://localhost:2375/'); });
`;

const HONEST = `
import { createServer } from 'node:http';
const s = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
s.listen(0, '127.0.0.1', () => { console.log('ready - local: http://localhost:' + s.address().port); });
`;

test('⚠️⚠️ END TO END: a lying process is NOT probed, and the refusal says why', async () => {
  const exec = workspace({ 'liar.mjs': LIAR });
  const started = startBackground({ program: 'node', args: ['liar.mjs'], executor: exec });
  assert.equal(started.ok, true, started.error);

  let probed = 0;
  const spy = async () => { probed += 1; return { reachable: true, status: 200 }; };

  const got = await until(async () => {
    const c = await checkBackground(started.id, { probe: spy });
    return c.port === 2375 ? c : null;
  });
  assert.ok(got, 'the process never announced the port it was told to lie about');

  assert.equal(got.portVerified, false, 'the port belongs to someone else (or nobody) — it is not ours');
  assert.equal(probed, 0, '⚠️ NOTHING may be probed on an unverified port — this is the whole defect');
  assert.equal(got.probe, undefined);
  assert.match(got.note, /NOT confirmed to belong to it/);

  const listed = listBackground().find((p) => p.id === started.id);
  assert.equal(listed.portVerified, false, 'http-probe.mjs matches on this list; it must see the verdict, not just the number');
});

test('⭐⭐ END TO END: an honest server is verified and IS probed — the guard does not break correct work', async () => {
  const exec = workspace({ 'honest.mjs': HONEST });
  const started = startBackground({ program: 'node', args: ['honest.mjs'], executor: exec });
  assert.equal(started.ok, true, started.error);

  const got = await until(async () => {
    const c = await checkBackground(started.id);
    return c.probe?.reachable === true ? c : null;
  });
  assert.ok(got, 'a real server that announced its real port must still be reachable');
  assert.equal(got.portVerified, true);
  assert.equal(got.probe.status, 200);
  assert.match(got.note, /it is listening/);

  const listed = listBackground().find((p) => p.id === started.id);
  assert.equal(listed.portVerified, true);
});
