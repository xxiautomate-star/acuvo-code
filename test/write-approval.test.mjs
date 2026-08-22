import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteApprover, refusedWriteResult } from '../lib/write-approval.mjs';
import { executeToolCall } from '../lib/tools.mjs';

/** A minimal in-memory executor — the same shape the browser builder uses. */
function memExecutor(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    root: '/mem',
    written: [],
    readFile(path) {
      return store.has(path)
        ? { ok: true, content: store.get(path) }
        : { ok: false, error: 'not found' };
    },
    writeFile(path, content) {
      store.set(path, content);
      this.written.push(path);
      return { ok: true, path };
    },
    listDir() { return { ok: true, entries: [] }; },
  };
}

const call = (name, args) => ({ id: 't1', function: { name, arguments: JSON.stringify(args) } });

test('with no approver every write proceeds — existing callers are byte-identical', async () => {
  const ex = memExecutor({ 'a.txt': 'x'.repeat(500) });
  const r = await executeToolCall(call('write_file', { path: 'a.txt', content: 'y' }), ex, {});
  assert.equal(r.result.ok, true);
  assert.deepEqual(ex.written, ['a.txt']);
});

test('⚠️⚠️ an unattended run is never blocked — no asker means the write lands', async () => {
  /**
   * THE DESIGN DECISION diff-preview.mjs argues in its header, pinned here. A
   * gate that breaks CI, --parallel and the fleet gets switched off globally
   * with ACUVO_APPROVE=never, and then it protects nobody on the laptop either.
   */
  const ex = memExecutor({ 'a.txt': 'x'.repeat(500) });
  const approver = createWriteApprover({ ask: null, isInteractive: false, env: {} });
  const r = await executeToolCall(call('write_file', { path: 'a.txt', content: 'y' }), ex, {
    approveWrite: approver.approve,
  });
  assert.equal(r.result.ok, true, 'an unattended write must not be refused');
  assert.equal(approver.state.asked, 0, 'and nobody should have been asked');
});

test('a declined write is refused, and the model is told not to retry', async () => {
  const ex = memExecutor({ 'a.txt': 'x'.repeat(5000) });
  const approver = createWriteApprover({
    ask: async () => 'n', isInteractive: true, env: { ACUVO_APPROVE: 'always' },
  });
  const r = await executeToolCall(call('write_file', { path: 'a.txt', content: 'totally different' }), ex, {
    approveWrite: approver.approve,
  });
  assert.equal(r.result.ok, false);
  assert.equal(r.mutated, false, 'a refused write must not report itself as a mutation');
  assert.deepEqual(ex.written, [], 'and nothing may reach the executor');
  // ⚠️ The refusal has to read as a person's decision, or the agent retries it.
  assert.match(r.result.error, /declined by the person/);
  assert.match(r.result.error, /Do not retry/);
});

test('⭐ "all remaining" is remembered across rounds — that is the whole per-run memory', async () => {
  const ex = memExecutor({ 'a.txt': 'x'.repeat(5000), 'b.txt': 'y'.repeat(5000) });
  let asked = 0;
  const approver = createWriteApprover({
    ask: async () => { asked += 1; return 'a'; },
    isInteractive: true,
    env: { ACUVO_APPROVE: 'always' },
  });
  const opts = { approveWrite: approver.approve };
  await executeToolCall(call('write_file', { path: 'a.txt', content: 'new one' }), ex, opts);
  await executeToolCall(call('write_file', { path: 'b.txt', content: 'new two' }), ex, opts);
  assert.equal(asked, 1, 'the second write must not re-ask after "all remaining"');
  assert.deepEqual(ex.written, ['a.txt', 'b.txt']);
});

test('⚠️ an asker that throws means nobody answered, not "no"', async () => {
  /**
   * A closed pipe mid-run must not become a refusal that looks like the user
   * vetoing the work — the agent then reports being blocked by a person who
   * was never there, which is the least legible failure available.
   */
  const ex = memExecutor({ 'a.txt': 'x'.repeat(5000) });
  const approver = createWriteApprover({
    ask: async () => { throw new Error('stdin closed'); },
    isInteractive: true,
    env: { ACUVO_APPROVE: 'always' },
  });
  const r = await executeToolCall(call('write_file', { path: 'a.txt', content: 'z' }), ex, {
    approveWrite: approver.approve,
  });
  assert.equal(r.result.ok, true, 'a broken pipe must not veto the write');
});

test('ACUVO_APPROVE=never asks nothing at all', async () => {
  const ex = memExecutor({ 'a.txt': 'x'.repeat(5000) });
  const approver = createWriteApprover({
    ask: async () => 'n', isInteractive: true, env: { ACUVO_APPROVE: 'never' },
  });
  await executeToolCall(call('write_file', { path: 'a.txt', content: 'z' }), ex, {
    approveWrite: approver.approve,
  });
  assert.equal(approver.state.asked, 0);
  assert.deepEqual(ex.written, ['a.txt']);
});

test('the bulk write is gated ONCE on the batch, not once per file', async () => {
  const ex = memExecutor();
  let asked = 0;
  const approver = createWriteApprover({
    ask: async () => { asked += 1; return 'n'; },
    isInteractive: true,
    env: { ACUVO_APPROVE: 'always' },
  });
  const r = await executeToolCall(call('write_files', {
    files: [{ path: 'a.txt', content: '1' }, { path: 'b.txt', content: '2' }, { path: 'c.txt', content: '3' }],
  }), ex, { approveWrite: approver.approve, approveBatch: approver.approveMany });
  assert.equal(asked, 1, 'three files must not become three prompts');
  assert.equal(r.result.ok, false);
  assert.deepEqual(ex.written, []);
});

test('refusedWriteResult never claims success', () => {
  const r = refusedWriteResult('x.txt');
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
});
