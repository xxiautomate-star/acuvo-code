/**
 * ── find_usages — USES OF A NAME IN CODE, WITH NO LANGUAGE SERVER ───────────
 * The traps are the point: the same word in a comment, in a string, in a
 * longer identifier, in a template, in HTML prose. `search_text` returns all
 * of them; this must return none of them.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findUsages, maskCodeComments, usagesToolSchemas, formatUsagesForModel, MAX_USAGE_LOCATIONS } from '../lib/usages.mjs';
import { TOOL_SCHEMAS, toolNamesForRounds, executeToolCall } from '../lib/tools.mjs';
import { LSP_TOOL_NAMES } from '../lib/lsp.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-usages-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"u","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const APP = `// saveNote is defined below; this comment mentions saveNote twice: saveNote
export function saveNote(note) {
  const label = "call saveNote() to persist"; // a string, not a call
  const tpl = \`saveNote in a template\`;
  return persist(note, label, tpl);
}
const saveNoteOnce = () => saveNote({}); /* saveNote in a block comment */
`;
const UI = `import { saveNote } from './app.js';
button.addEventListener('click', () => saveNote(read()));
`;
const PY = `# saveNote in a python comment
def handler():
    """saveNote in a docstring"""
    return saveNote(1)
`;
const HTML = `<!-- saveNote in an html comment -->
<p>Press save to run saveNote.</p>
<button onclick="saveNote()">save</button>
<script>window.saveNote = saveNote; // saveNote trailing comment</script>
`;

test('⭐ comments, strings, templates and longer identifiers are not uses', () => {
  const root = workspace({ 'app.js': APP, 'ui.js': UI, 'worker.py': PY, 'index.html': HTML });
  const r = findUsages(root, 'saveNote');
  assert.equal(r.ok, true, r.error);
  const where = r.locations.map((l) => `${l.path}:${l.line}${l.defines ? '*' : ''}`);
  assert.deepEqual(where, [
    'app.js:2*',        // the definition
    'app.js:7*',        // the real call inside saveNoteOnce's body
    'ui.js:1',          // the import
    'ui.js:2',          // the call
    'worker.py:4',      // the python call
  ]);
  // ⚠️ index.html is NOT swept: the walk is the symbol index's, which opens
  // source files only. An inline handler in HTML is a use this tool misses,
  // and the note says so rather than pretending the sweep was whole.
  assert.equal(r.count, 5);
  assert.deepEqual(r.definingFiles, ['app.js']);
  assert.equal(r.filesWithUses, 3);
  assert.match(r.note, /HTML/);
  // and the excerpt is the source line, not the masked one
  assert.match(r.locations[0].excerpt, /export function saveNote\(note\)/);
  assert.match(r.note, /masked/);
});

test('the mask keeps every offset — line and column point at the real source', () => {
  const src = 'const a = "x // y"; /* c */ let b = a; // tail\nlet c = `t`; let d = b;';
  const masked = maskCodeComments(src, 'f.js');
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.ok(!masked.includes('tail') && !masked.includes('x // y') && !masked.includes('/* c */'));
  assert.ok(masked.includes('let b = a') && masked.includes('let d = b'));
  // python: hash comments and triple quotes
  const py = maskCodeComments('x = 1  # note\ns = """multi\nline"""\ny = x', 'f.py');
  assert.ok(!py.includes('note') && !py.includes('multi') && py.includes('y = x'));
});

test('an unterminated quote in prose cannot swallow the rest of the file', () => {
  const root = workspace({ 'a.js': "const s = 'oops\nuse(target);\n", 'b.js': 'function target() {}\n' });
  const r = findUsages(root, 'target');
  assert.equal(r.count, 2);
});

test('refuses a pattern, caps the listing, and says when the cap was hit', () => {
  const bad = findUsages(workspace({}), 'a.*b');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /search_text/);
  const many = Array.from({ length: 70 }, (_, i) => `use${i}(thing);`).join('\n');
  const r = findUsages(workspace({ 'm.js': many, 'd.js': 'export const thing = 1;' }), 'thing');
  assert.equal(r.count, 71);
  assert.equal(r.shown, MAX_USAGE_LOCATIONS);
  assert.equal(r.truncated, true);
  assert.match(r.note, /showing the first 60/);
  const few = findUsages(workspace({ 'm.js': many }), 'thing', { limit: 5 });
  assert.equal(few.shown, 5);
  assert.match(few.note, /no file in the index DEFINES/);
});

test('⭐⭐ declared once, not an LSP name, offered in the core set, and dispatched', async () => {
  assert.deepEqual(usagesToolSchemas().map((s) => s.function.name), ['find_usages']);
  assert.equal(LSP_TOOL_NAMES.includes('find_usages'), false);
  assert.equal(TOOL_SCHEMAS.filter((s) => s.function.name === 'find_usages').length, 1);
  const root = workspace({ 'a.js': 'export function ping() {}\n', 'b.js': "import { ping } from './a.js'; ping();\n" });
  const offered = toolNamesForRounds(16, { root, env: {}, allowRun: false });
  assert.ok(offered.includes('find_usages'), 'declared but never offered');
  const record = await executeToolCall(
    { id: 'c1', function: { name: 'find_usages', arguments: JSON.stringify({ name: 'ping' }) } },
    { root, dryRun: true },
    {},
  );
  assert.equal(record.mutated, false);
  assert.equal(record.result.ok, true, record.result.error);
  assert.equal(record.result.count, 3);
  const text = formatUsagesForModel(record.result);
  assert.match(text, /ping: 3 uses in 2 files/);
  assert.match(text, /a\.js:1:17  \[defines\]/);
});
