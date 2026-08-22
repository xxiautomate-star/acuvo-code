import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DIAGNOSTICS_PER_FILE, formatDiagnosticsBlock, diagnosticsAfterWrite, writtenPathsOf, rememberBaseline, resetBaselines,
} from '../lib/edit-diagnostics.mjs';

/**
 * ── ⭐⭐⭐ WE OWNED THE LANGUAGE SERVERS AND NEVER LISTENED TO THEM ───────────
 *
 * `lib/lsp.mjs` starts typescript-language-server, pyright, rust-analyzer and
 * gopls, and exports `diagnostics(root, file)`. Until now the model only heard
 * from them if it CHOSE to call `check_types` — and measured across agents,
 * models reach for symbol tools **0–6% of the time**. So the compiler was
 * running, knew the file was broken, and said nothing.
 *
 * ⭐ THE EVIDENCE THIS IS THE HIGHEST-VALUE CHANGE AVAILABLE. Self-critique
 * WITHOUT an external signal is measured to make things worse — six settings out
 * of six went down or flat, and GPT-3.5 lost 37.7 points on one benchmark in a
 * single round (arXiv:2310.01798). With an EXTERNAL signal it works: replacing a
 * model's own feedback with real feedback took repaired-and-passing from 33.3%
 * to 52.6% (arXiv:2306.09896). A compiler error is exactly that external signal,
 * and it costs no model call. SWE-agent's own ablation puts the linter-on-edits
 * mechanism at +3.0 points — larger than removing all search (-2.3).
 *
 * ⚠️ ERRORS ONLY, NEVER STYLE. Aider's linter is deliberately narrow — syntax
 * errors and undefined names, no formatting — because feeding style warnings
 * back makes the model chase noise instead of the defect it just introduced.
 */

const err = (message, line = 1) => ({ severity: 1, message, line, column: 1 });
const warn = (message, line = 1) => ({ severity: 2, message, line, column: 1 });

test('a clean write says nothing at all', async () => {
  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: [] }),
  });
  assert.equal(out, null, 'a silent compiler must add ZERO tokens to the result');
});

test('⭐ an error the model just introduced comes back with the write', async () => {
  const out = await diagnosticsAfterWrite('/root', ['src/app.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: [err("Cannot find name 'usreState'.", 12)] }),
  });
  assert.match(out, /usreState/);
  assert.match(out, /src\/app\.ts/);
  assert.match(out, /12/);
});

/**
 * ⚠️ A TAGGED BLOCK, NOT LOOSE PROSE. Tool results are the first thing context
 * compaction clamps, and an unlabelled paragraph of compiler output is
 * indistinguishable from any other long result. A named block can be found,
 * superseded by a later one for the same file, and dropped as a unit.
 */
test('⚠️ the block is tagged with the file so compaction can supersede it', async () => {
  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: [err('boom')] }),
  });
  assert.match(out, /<diagnostics file="a\.ts">/);
  assert.match(out, /<\/diagnostics>/);
});

/**
 * ⚠️ STYLE IS NOISE. A model handed 40 formatting warnings after a correct edit
 * will "fix" them and burn a round. Only severity 1 — an actual error — earns
 * the tokens.
 */
test('⚠️ warnings and hints are dropped; only errors earn the tokens', async () => {
  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: [warn('prefer const'), { severity: 3, message: 'info' }] }),
  });
  assert.equal(out, null);
});

test(`⚠️ capped at ${MAX_DIAGNOSTICS_PER_FILE} per file, and it says how many it hid`, async () => {
  const many = Array.from({ length: 50 }, (_, i) => err(`error number ${i}`, i + 1));
  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: many }),
  });
  assert.match(out, /error number 0/);
  assert.doesNotMatch(out, /error number 49/, 'the cap must actually cap');
  assert.match(out, /30 more/, 'a silent truncation is a lie about the state of the file');
});

/**
 * ⚠️⚠️ A DIAGNOSTICS FAILURE MUST NEVER FAIL A WRITE. The file landed on disk.
 * Turning "we could not reach the language server" into a failed edit would
 * make a working change look broken, and this repo has already paid for a
 * verifier that failed correct work — four times in one day.
 */
test('⚠️⚠️ an unavailable or throwing language server is silent, never fatal', async () => {
  assert.equal(await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => ({ ok: false, error: 'no server on PATH' }),
  }), null);

  assert.equal(await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => { throw new Error('server died mid-handshake'); },
  }), null);
});

/**
 * ⚠️ AND IT MUST NOT HANG A WRITE EITHER. A language server that never answers
 * would otherwise hold the whole turn open.
 */
test('⚠️ a language server that never answers is abandoned, not waited on', async () => {
  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    timeoutMs: 30,
    diagnosticsImpl: () => new Promise(() => {}),
  });
  assert.equal(out, null);
});

test('files no language server handles are skipped without a probe', async () => {
  let called = 0;
  const out = await diagnosticsAfterWrite('/root', ['README.md', 'logo.svg'], {
    diagnosticsImpl: async () => { called += 1; return { ok: true, items: [err('x')] }; },
  });
  assert.equal(out, null);
  assert.equal(called, 0, 'a markdown file must not start a language server');
});

test('several written files each get their own block', async () => {
  const out = await diagnosticsAfterWrite('/root', ['a.ts', 'b.ts'], {
    diagnosticsImpl: async (_root, file) => ({ ok: true, items: [err(`bad thing in ${file}`)] }),
  });
  assert.match(out, /<diagnostics file="a\.ts">/);
  assert.match(out, /<diagnostics file="b\.ts">/);
});

test('formatDiagnosticsBlock is pure and returns null for nothing worth saying', () => {
  assert.equal(formatDiagnosticsBlock('a.ts', []), null);
  assert.equal(formatDiagnosticsBlock('a.ts', [warn('style')]), null);
  assert.match(formatDiagnosticsBlock('a.ts', [err('real', 3)]), /a\.ts/);
});

/**
 * ⚠️ WHICH FILES ACTUALLY GOT BYTES — read from the RESULT, never the arguments.
 * A refused write, a dry run and a partial batch all differ, and asking a
 * language server about a file that was never written yields a diagnostic about
 * the version already on disk — which reads as "your edit broke this" when the
 * edit never happened.
 */
test('writtenPathsOf reports only what actually landed', () => {
  assert.deepEqual(writtenPathsOf({ name: 'write_file', result: { ok: true, path: 'a.ts' } }), ['a.ts']);
  assert.deepEqual(writtenPathsOf({ name: 'edit_file', result: { ok: true, path: 'b.ts' } }), ['b.ts']);
  assert.deepEqual(writtenPathsOf({ name: 'move_file', result: { ok: true, from: 'old.ts', to: 'new.ts' } }), ['new.ts']);

  // a dry run wrote nothing
  assert.deepEqual(writtenPathsOf({ name: 'write_file', result: { ok: true, dryRun: true, path: 'a.ts' } }), []);
  // a refusal wrote nothing
  assert.deepEqual(writtenPathsOf({ name: 'write_file', result: { ok: false, error: 'denied' } }), []);
  // a shell command may have written anything; we do not guess
  assert.deepEqual(writtenPathsOf({ name: 'run_command', result: { ok: true } }), []);
});

test('writtenPathsOf handles a partial batch — 2 of 3 landed', () => {
  const out = writtenPathsOf({
    name: 'write_files',
    result: { ok: true, written: [{ path: 'a.ts' }, 'b.ts'] },
  });
  assert.deepEqual(out, ['a.ts', 'b.ts']);
});

/**
 * ── ⚠️⚠️⚠️ NEVER BLAME THE MODEL FOR BREAKAGE THAT WAS ALREADY THERE ─────────
 *
 * The first version of this module reported EVERY error in the file after a
 * write. In a repo that already has type errors — which is most real repos — a
 * model that wrote a perfectly correct file is handed a list of someone else's
 * bugs and told "fix these before continuing". It will. That is a whole round,
 * at full price, spent on work nobody asked for, and it ends with a diff the
 * user did not want.
 *
 * SWE-agent's edit guard runs the linter BEFORE and AFTER and diffs the error
 * sets, for exactly this reason. This is that, with the baseline captured when
 * the file is READ (OpenCode's trick — the read tool warms the server
 * fire-and-forget) so a write does not pay for two round-trips.
 *
 * ⚠️ FINGERPRINTED BY MESSAGE, NOT BY LINE. An edit shifts every line below it,
 * so a line-keyed baseline would report the whole tail of the file as new. Keyed
 * by message WITH A COUNT: three instances before and four after means ONE new
 * one, which is the fact the model needs.
 */
test('⚠️⚠️ pre-existing errors are not reported as the model\'s fault', async () => {
  resetBaselines();
  rememberBaseline('a.ts', [err('Cannot find module "legacy".', 3)]);

  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    // the same old error, now on a different line because the edit shifted it
    diagnosticsImpl: async () => ({ ok: true, items: [err('Cannot find module "legacy".', 41)] }),
  });
  assert.equal(out, null, 'an untouched pre-existing error must stay silent');
});

test('⭐ a NEW error is reported even when the file already had others', async () => {
  resetBaselines();
  rememberBaseline('a.ts', [err('Cannot find module "legacy".', 3)]);

  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: [
      err('Cannot find module "legacy".', 41),
      err("Type 'string' is not assignable to type 'number'.", 12),
    ] }),
  });
  assert.match(out, /not assignable/);
  assert.doesNotMatch(out, /legacy/, 'the old one is still not ours');
});

/**
 * ⚠️ A SECOND INSTANCE OF THE SAME MESSAGE IS STILL NEW. Keying by message alone
 * would let a model introduce four more of an error that already existed once
 * and hear nothing.
 */
test('⚠️ a new INSTANCE of an existing message counts', async () => {
  resetBaselines();
  rememberBaseline('a.ts', [err('Unused variable.', 1)]);
  const out = await diagnosticsAfterWrite('/root', ['a.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: [err('Unused variable.', 1), err('Unused variable.', 9)] }),
  });
  assert.match(out, /Unused variable/);
});

test('with no baseline at all, everything is reported — we cannot know otherwise', async () => {
  resetBaselines();
  const out = await diagnosticsAfterWrite('/root', ['fresh.ts'], {
    diagnosticsImpl: async () => ({ ok: true, items: [err('boom')] }),
  });
  assert.match(out, /boom/);
});

/**
 * ⭐ AND THE WRITE UPDATES THE BASELINE, so an error the model introduced and
 * was told about is not reported again on the next write. Being told twice about
 * something you are already fixing is how a loop starts.
 */
test('⭐ an error already reported once is not reported again', async () => {
  resetBaselines();
  const items = [err('Cannot find name "foo".', 2)];
  const impl = async () => ({ ok: true, items });

  const first = await diagnosticsAfterWrite('/root', ['a.ts'], { diagnosticsImpl: impl });
  assert.match(first, /Cannot find name/);

  const second = await diagnosticsAfterWrite('/root', ['a.ts'], { diagnosticsImpl: impl });
  assert.equal(second, null, 'the same unfixed error must not be re-announced every write');
});
