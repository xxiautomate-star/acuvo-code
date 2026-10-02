/**
 * `--output-format stream-json` — parity with `claude -p --output-format
 * stream-json` and `codex exec --json` (both read 2026-09-27). The contract is
 * that EVERY line parses, whatever an event carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { streamLine, initLine, eventLine, resultLine, MAX_STREAM_STRING_CHARS } from '../lib/stream-json.mjs';
import { parseArgv, OUTPUT_FORMATS, USAGE } from '../lib/cli-args.mjs';

test('⭐⭐⭐ a hostile event still produces exactly one parseable line', () => {
  const cyc = { a: 1 };
  cyc.self = cyc;
  const nasty = {
    type: 'tool', fn: () => 1, big: 10n, err: new Error('boom'), cyc,
    text: 'line one\nline two', huge: 'x'.repeat(MAX_STREAM_STRING_CHARS + 50),
  };
  const line = eventLine(nasty);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false, 'a raw newline would split one event into two broken lines');
  const back = JSON.parse(line);
  assert.equal(back.type, 'event');
  assert.equal(back.event.type, 'tool', 'the loop\'s own event object travels, not a second vocabulary');
  assert.equal(back.event.big, '10');
  assert.equal(back.event.err.message, 'boom');
  assert.equal(back.event.cyc.self, '[circular]');
  assert.equal('fn' in back.event, false);
  assert.match(back.event.huge, /\[cut, \d+ characters total\]$/, 'a cut is announced, never silent');
});

test('init and result lines, and a document\'s own `type` cannot overwrite the line kind', () => {
  assert.deepEqual(JSON.parse(initLine({ version: '1.2.3', task: 't', cwd: '/w' })), { type: 'init', version: '1.2.3', task: 't', cwd: '/w' });
  const r = JSON.parse(resultLine({ ok: true, type: 'sneaky', exitCode: 0 }));
  assert.equal(r.type, 'result');
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(streamLine('x', { a: undefined })).type, 'x');
});

test('--output-format parses, implies --json, and refuses a typo', () => {
  assert.deepEqual([...OUTPUT_FORMATS], ['text', 'json', 'stream-json']);
  const s = parseArgv(['--output-format', 'stream-json', 'do a thing']);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.options.json, true, 'stdout must carry only JSON, which is the --json contract');
  assert.equal(s.options.streamJson, true);
  const j = parseArgv(['--output-format', 'json', 'x']);
  assert.equal(j.options.json, true);
  assert.equal(j.options.streamJson, false);
  const bad = parseArgv(['--output-format', 'ndjson', 'x']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /text, json, stream-json/);
  const help = Array.isArray(USAGE) ? USAGE.join('\n') : String(USAGE);
  assert.match(help, /--output-format/, 'a flag --help never names is a flag nobody finds');
});

test('⭐⭐ a config file cannot override --output-format (the layer that scans argv must see it)', async () => {
  // MEASURED 2026-09-27 driving the real CLI: with `--output-format` missing
  // from rcfile's flag map, the resolved `json:false` default won, and the
  // stream carried the banner and every human line on stdout.
  const { explicitKeysFromArgv } = await import('../lib/rcfile.mjs');
  assert.ok(explicitKeysFromArgv(['--output-format', 'stream-json', 'task']).has('json'));
  const { FLAGS } = await import('../lib/completion.mjs');
  const f = FLAGS.find((x) => x.name === '--output-format');
  assert.ok(f && f.value, '--output-format must be a VALUE flag, or its value is scanned as a flag');
});
