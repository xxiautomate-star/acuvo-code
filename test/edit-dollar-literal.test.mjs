// ⭐ new_string is TEXT, never a replacement pattern (2026-09-26, a real run).
// `String.prototype.replace(str, str)` expands `$$`, `$&`, `` $` `` and `$'` in
// its second argument, so a money formatter's `` `$${dollars}` `` was written as
// `` `${dollars}` `` while the tool reported success — four rounds lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../lib/edit.mjs';

test('a literal $$ in new_string is written byte-for-byte', () => {
  const content = 'const rest = x;\nreturn `${sign}${dollars}.${rest}`;\n';
  const r = applyEdit(content, 'return `${sign}${dollars}.${rest}`;', 'return `${sign}$${dollars}.${rest}`;');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'const rest = x;\nreturn `${sign}$${dollars}.${rest}`;\n');
});

test("$&, $` and $' in new_string are not expanded", () => {
  const content = 'A-OLD-B';
  const r = applyEdit(content, 'OLD', "$&|$`|$'|$1");
  assert.equal(r.ok, true);
  assert.equal(r.content, "A-$&|$`|$'|$1-B");
});

test('the CRLF-tolerant path keeps $$ literal too', () => {
  const content = 'a\r\nprice = "$1";\r\nb\r\n';
  const r = applyEdit(content, 'a\nprice = "$1";', 'a\nprice = "$$1";');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'a\r\nprice = "$$1";\r\nb\r\n');
});
