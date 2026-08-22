/**
 * ── ⭐⭐ THE AGENT COULD NOT FIND THE FILES IT WROTE ITSELF ───────────────────
 *
 * Everything this package persists — the plan, the board, the checkpoint
 * journal, `policy.json`, the acceptance record, the audit log — lands in
 * `.acuvo/`. The walk skipped every dotted entry, so all of it was invisible to
 * `find_files` and `search_text`, and the reply was the `matches: [] /
 * skippedCount: 0` triple this module documents as meaning "not there". An
 * agent resuming a job could not answer "what did I already do?" about its own
 * output, and a model that is told something is absent stops looking and
 * invents.
 *
 * ⚠️⚠️ AND THE DIRECTORY IT HAS TO REACH IS THE ONE THE CREDENTIAL LIVES IN.
 * `~/.acuvo/credentials.json` holds the account token. Run the agent with the
 * workspace set to your home directory — which nobody should do and somebody
 * will — and the file it must never read is a direct child of the directory it
 * now walks. The guard is NOT the allowlist: it is `refusedCommitPath`, which
 * matches `credentials.json` wherever it sits, and which `searchText` consults
 * before reading a byte. These tests assert the TOKEN never comes back, not
 * that a constant has a particular value, because the constant is not what
 * keeps it in.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFiles, searchText } from '../lib/search.mjs';

const TOKEN = 'acuvo_live_NEVER_LEAVES_THE_MACHINE';

/** A workspace shaped like a real one mid-run: source, plus a populated .acuvo. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'export const widget = 1;\n');

  mkdirSync(join(root, '.acuvo', 'board'), { recursive: true });
  mkdirSync(join(root, '.acuvo', 'audit'), { recursive: true });
  mkdirSync(join(root, '.acuvo', 'sessions'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'policy.json'), '{"maxUsd":5,"widget":true}\n');
  writeFileSync(join(root, '.acuvo', 'board', 't3.json'), '{"title":"wire the widget"}\n');
  writeFileSync(join(root, '.acuvo', 'audit', '2026-08-15.jsonl'), '{"cmd":"npm test","widget":1}\n');
  // The credential, exactly where the account layer puts it.
  writeFileSync(join(root, '.acuvo', 'credentials.json'), JSON.stringify({ token: TOKEN, email: 'a@b.c' }));
  // A session transcript: the agent's own prose, mentioning the same symbol.
  writeFileSync(
    join(root, '.acuvo', 'sessions', '20260815-0001.json'),
    JSON.stringify({ messages: [{ role: 'assistant', content: 'I think widget is probably unused.' }] }),
  );
  return root;
}

/** `findFiles` returns `files` (strings); `searchText` returns `matches` (objects). */
const paths = (r) => (r.files ?? r.matches).map((m) => (typeof m === 'string' ? m : m.path));

test('⭐⭐ find_files reaches .acuvo — the plan, the board and the audit log are findable', () => {
  const root = workspace();
  const found = paths(findFiles(root, '**/*.json'));
  assert.ok(found.includes('.acuvo/policy.json'), `policy.json missing from: ${found.join(', ')}`);
  assert.ok(found.includes('.acuvo/board/t3.json'), 'the board must be reachable at depth');
});

test('⭐ search_text reads .acuvo content — this is the half that answers "what did I already do?"', () => {
  const root = workspace();
  const hits = searchText(root, 'widget');
  const files = new Set(paths(hits));
  assert.ok(files.has('.acuvo/policy.json'), `expected policy.json in: ${[...files].join(', ')}`);
  assert.ok(files.has('.acuvo/audit/2026-08-15.jsonl'), 'the audit log must be searchable');
  assert.ok(files.has('src/app.js'), 'ordinary source must still be found — this is not a swap');
});

test('⚠️⚠️ the TOKEN never comes back, even though the directory is now walked', () => {
  const root = workspace();
  // Search for the token itself: the most direct exfiltration attempt there is.
  const direct = searchText(root, 'acuvo_live_');
  assert.equal(
    JSON.stringify(direct).includes(TOKEN), false,
    'the account token appeared in a search result — the credential is reachable',
  );
  // And a search that would match its neighbours must not drag it along.
  const wide = searchText(root, 'a@b.c');
  assert.equal(JSON.stringify(wide).includes(TOKEN), false, 'the token leaked via an adjacent match');
});

test('⭐ the credential is NAMED, not silently dropped — withholding quietly is the lie this module was fixed for', () => {
  const root = workspace();
  const hits = searchText(root, 'acuvo_live_');
  const text = JSON.stringify(hits);
  assert.match(text, /credentials\.json/, 'the model must be told the file exists and its contents are not coming');
  assert.match(text, /credential file/i);
});

test('⚠️ .acuvo/sessions is skipped, and the reply SAYS SO', () => {
  const root = workspace();
  // `widget` appears in the session transcript as the agent's own guess
  // ("probably unused"). Returned in a result list it is indistinguishable from
  // source, and the older speculation reads as evidence.
  const hits = searchText(root, 'widget');
  assert.equal(paths(hits).some((p) => p.includes('sessions')), false, 'a transcript was returned as if it were source');
  const skipped = JSON.stringify(hits.skipped ?? hits.hiddenSkipped ?? []);
  assert.match(skipped, /sessions/, 'the skip must be recorded, or the reply means "not there"');
  assert.match(skipped, /acuvo --sessions/, 'a skip without the way through is a dead end');
});

test('⚠️ the sessions rule is DEPTH-ONE — a src/sessions directory is ordinary source', () => {
  /**
   * The rule keys on "direct child of .acuvo", not on the name `sessions`
   * anywhere. A project with `src/sessions/login.js` must be unaffected; a rule
   * that swallowed it would be a silent hole in an ordinary codebase.
   */
  const root = workspace();
  mkdirSync(join(root, 'src', 'sessions'), { recursive: true });
  writeFileSync(join(root, 'src', 'sessions', 'login.js'), 'export const widget = 2;\n');
  assert.ok(paths(searchText(root, 'widget')).includes('src/sessions/login.js'));
});

test('⚠️ .env inside .acuvo is still never read — the hidden-FILE rule is untouched', () => {
  const root = workspace();
  writeFileSync(join(root, '.acuvo', '.env'), 'OPENROUTER_API_KEY=sk-should-never-appear\n');
  const hits = searchText(root, 'OPENROUTER_API_KEY');
  assert.equal(JSON.stringify(hits).includes('sk-should-never-appear'), false);
});
