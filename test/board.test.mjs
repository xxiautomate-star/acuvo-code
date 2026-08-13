/**
 * The task board — the last missing piece of "seven terminals, seven workers".
 *
 * ⭐ The design claim under test is that there is NO NEW LOCKING here: a task is
 * a file, claiming one is taking a lease on that file, and `lease.mjs` already
 * does exclusive claim, TTL reclaim and takeover caps. These tests use REAL
 * leases for exactly that reason — stubbing them would test the stub and prove
 * nothing about the property the design rests on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boardAdd, boardList, boardClaim, boardDone, formatBoard, BOARD_DIR, MAX_TASK_CHARS } from '../lib/board.mjs';
import { release } from '../lib/lease.mjs';

const made = [];
const ws = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-board-')); made.push(d); return d; };
const cleanup = () => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ } } };

test('a task added is a task listed', (t) => {
  t.after(cleanup);
  const root = ws();
  const a = boardAdd(root, '  make   the failing suite pass  ');
  assert.equal(a.ok, true);
  const listed = boardList(root);
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].task, 'make the failing suite pass', 'whitespace must be normalised, or two spellings of one task look like two tasks');
  assert.equal(listed.tasks[0].state, 'todo');
  assert.equal(listed.tasks[0].heldBy, null);
});

test('⭐⭐ TWO TERMINALS NEVER GET THE SAME TASK', (t) => {
  t.after(cleanup);
  const root = ws();
  boardAdd(root, 'port the auth module');
  boardAdd(root, 'fix the CSS');

  const one = boardClaim(root, { holder: 't1' });
  const two = boardClaim(root, { holder: 't2' });

  assert.equal(one.ok, true, `terminal 1 got nothing: ${one.ok === false ? one.error : ''}`);
  assert.equal(two.ok, true, `terminal 2 got nothing: ${two.ok === false ? two.error : ''}`);
  assert.notEqual(one.id, two.id, 'both terminals were handed the SAME task — the entire point of the board');
  release(one.lease); release(two.lease);
});

test('⭐ the board says who is doing what, from the LEASE not from the file', (t) => {
  t.after(cleanup);
  const root = ws();
  boardAdd(root, 'port the auth module');
  const claimed = boardClaim(root, { holder: 'terminal-4' });

  const listed = boardList(root);
  assert.equal(listed.tasks[0].heldBy, 'terminal-4');
  /**
   * A holder written into the task file would be a second copy of a fact the
   * lease layer owns, and it would go stale the moment a worker died — a dead
   * process cannot come back to correct its own file. Releasing must therefore
   * clear the holder with no write to the task at all.
   */
  release(claimed.lease);
  assert.equal(boardList(root).tasks[0].heldBy, null, 'the holder outlived the lease, so it was a copy rather than the truth');
});

test('⚠️ a claimed task is not offered again while it is held', (t) => {
  t.after(cleanup);
  const root = ws();
  boardAdd(root, 'the only task');
  const first = boardClaim(root, { holder: 't1' });
  assert.equal(first.ok, true);

  const second = boardClaim(root, { holder: 't2' });
  assert.equal(second.ok, false);
  assert.equal(second.empty, true);
  assert.match(second.error, /already held/, 'a refusal must distinguish "nothing to do" from "somebody else is doing it"');
  release(first.lease);
});

test('⭐ a released task returns to the board and the next terminal gets it', (t) => {
  t.after(cleanup);
  const root = ws();
  boardAdd(root, 'the only task');
  const first = boardClaim(root, { holder: 't1' });
  release(first.lease);

  const second = boardClaim(root, { holder: 't2' });
  assert.equal(second.ok, true, 'a released task must be immediately claimable — otherwise a crashed worker stalls the fleet');
  assert.equal(second.id, first.id);
  release(second.lease);
});

test('a finished task is not handed out again', (t) => {
  t.after(cleanup);
  const root = ws();
  boardAdd(root, 'do it once');
  const claimed = boardClaim(root, { holder: 't1' });
  assert.equal(boardDone(root, claimed.id, { lease: claimed.lease }).ok, true);

  const next = boardClaim(root, { holder: 't2' });
  assert.equal(next.ok, false, 'a completed task was offered to another terminal');
  assert.equal(boardList(root).tasks[0].state, 'done');
});

test('⚠️ an empty board and a fully-claimed board say DIFFERENT things', (t) => {
  t.after(cleanup);
  const root = ws();
  const empty = boardClaim(root, { holder: 't1' });
  assert.match(empty.error, /board is empty/);
  assert.match(empty.error, /board add/, 'a refusal that does not say what to type is just an obstacle');

  boardAdd(root, 'x');
  const held = boardClaim(root, { holder: 't1' });
  const blocked = boardClaim(root, { holder: 't2' });
  assert.ok(!/board is empty/.test(blocked.error), 'a busy board must not report itself as empty — they need opposite actions');
  release(held.lease);
});

test('⚠️ claiming without a holder is refused — an anonymous claim tells nobody anything', (t) => {
  t.after(cleanup);
  const root = ws();
  boardAdd(root, 'x');
  const r = boardClaim(root, { holder: '  ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /--holder/);
});

test('⚠️ an unreadable task is REPORTED, never silently skipped', (t) => {
  t.after(cleanup);
  const root = ws();
  boardAdd(root, 'a real one');
  mkdirSync(join(root, BOARD_DIR), { recursive: true });
  writeFileSync(join(root, BOARD_DIR, '20260813000000-zzz.json'), 'not json at all\n', 'utf8');

  const listed = boardList(root);
  assert.equal(listed.tasks.length, 2, 'a task nobody can parse is still work somebody wrote down');
  assert.ok(listed.tasks.some((t2) => t2.state === 'damaged'));
});

test('an oversized or empty task is refused with the reason', (t) => {
  t.after(cleanup);
  const root = ws();
  assert.match(boardAdd(root, '   ').error, /needs some text/);
  assert.match(boardAdd(root, 'x'.repeat(MAX_TASK_CHARS + 1)).error, /over the 400 limit/);
});

test('⚠️ two tasks added in the same millisecond are two tasks, not one', (t) => {
  t.after(cleanup);
  const root = ws();
  // A frozen clock is the worst case the id scheme has to survive.
  const clock = () => 1_760_000_000_000;
  let n = 0;
  const rand = () => [0.1, 0.9][n++ % 2];
  assert.equal(boardAdd(root, 'first', { clock, rand }).ok, true);
  assert.equal(boardAdd(root, 'second', { clock, rand }).ok, true);
  assert.equal(boardList(root).tasks.length, 2, 'one task overwrote the other — a board that loses work is worse than no board');
});

test('the rendered board shows state, holder and what to type', (t) => {
  t.after(cleanup);
  const root = ws();
  assert.match(formatBoard(boardList(root)), /board add/, 'an empty board must teach the next command');

  boardAdd(root, 'port the auth module');
  const claimed = boardClaim(root, { holder: 'terminal-2' });
  const text = formatBoard(boardList(root));
  assert.match(text, /port the auth module/);
  assert.match(text, /terminal-2/, 'a board that does not name the holder cannot answer "who is on this?"');
  assert.match(text, /1 task/);
  release(claimed.lease);
});
