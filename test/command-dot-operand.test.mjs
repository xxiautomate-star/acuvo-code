// ⭐ `.` as a command ARGUMENT is the workspace itself and always contained
// (2026-09-26, a real run: `tsc -p .` was refused with the file tools' "has to
// name a FILE" sentence, and the model had to guess another command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../lib/command.mjs';

test('tsc -p . and friends are accepted', () => {
  for (const c of ['tsc -p .', 'tsc --project .', 'tsc -p ./', 'node --test .']) {
    const v = validateCommand(c);
    assert.equal(v.ok, true, `${c}: ${v.error}`);
  }
});

test('escaping the workspace is still refused', () => {
  for (const c of ['tsc -p ..', 'tsc -p ../x', 'node --test ./..']) {
    assert.equal(validateCommand(c).ok, false, c);
  }
});
